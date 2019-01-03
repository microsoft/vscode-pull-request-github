/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as Octokit from '@octokit/rest';
import { ApolloClient, InMemoryCache, NormalizedCacheObject } from 'apollo-boost';
import { setContext } from 'apollo-link-context';

import * as vscode from 'vscode';
import { agent } from '../common/net';
import { IHostConfiguration, HostHelper } from '../authentication/configuration';
import { GitHubServer } from '../authentication/githubServer';
import { getToken, setToken } from '../authentication/keychain';
import { Remote } from '../common/remote';
import Logger from '../common/logger';
import { ITelemetry } from './interface';
import { handler as uriHandler } from '../common/uri';
import { createHttpLink } from 'apollo-link-http';
import fetch from 'node-fetch';

const TRY_AGAIN = 'Try again?';
const SIGNIN_COMMAND = 'Sign in';

const AUTH_INPUT_TOKEN_CMD = 'auth.inputTokenCallback';

export interface GitHub {
	octokit: Octokit;
	graphql: ApolloClient<NormalizedCacheObject>;
}

export class CredentialStore {
	private _octokits: Map<string, GitHub>;
	private _authenticationStatusBarItems: Map<string, vscode.StatusBarItem>;

	constructor(private readonly _telemetry: ITelemetry) {
		this._octokits = new Map<string, GitHub>();
		this._authenticationStatusBarItems = new Map<string, vscode.StatusBarItem>();
		vscode.commands.registerCommand(AUTH_INPUT_TOKEN_CMD, async () => {
			const uriOrToken = await vscode.window.showInputBox({ prompt: 'Token' });
			if (!uriOrToken) { return; }
			try {
				const uri = vscode.Uri.parse(uriOrToken);
				if (!uri.scheme) { throw new Error; }
				uriHandler.handleUri(uri);
			} catch (error) {
				// If it doesn't look like a URI, treat it as a token.
				const host = await vscode.window.showInputBox({ prompt: 'Server', placeHolder: 'github.com' });
				if (!host) { return; }
				setToken(host, uriOrToken);
			}
		});
	}

	public reset() {
		this._octokits = new Map<string, GitHub>();

		this._authenticationStatusBarItems.forEach(statusBarItem => statusBarItem.dispose());
		this._authenticationStatusBarItems = new Map<string, vscode.StatusBarItem>();
	}

	public async hasOctokit(remote: Remote): Promise<boolean> {
		// the remote url might be http[s]/git/ssh but we always go through https for the api
		// so use a normalized http[s] url regardless of the original protocol
		const normalizedUri = remote.gitProtocol.normalizeUri();
		const host = `${normalizedUri.scheme}://${normalizedUri.authority}`;

		if (this._octokits.has(host)) {
			return true;
		}

		const server = new GitHubServer(host);
		const token = await getToken(host);
		let octokit: GitHub;

		if (token) {
			if (await server.validate(token)) {
				octokit = this.createHub({ host, token });
			} else {
				Logger.debug(`Token is no longer valid for host ${host}.`, 'Authentication');
			}
		} else {
			Logger.debug(`No token found for host ${host}.`, 'Authentication');
		}

		if (octokit) {
			this._octokits.set(host, octokit);
		}
		await this.updateAuthenticationStatusBar(remote);
		return this._octokits.has(host);
	}

	public getHub(remote: Remote): GitHub {
		const normalizedUri = remote.gitProtocol.normalizeUri();
		const host = `${normalizedUri.scheme}://${normalizedUri.authority}`;
		return this._octokits.get(host);
	}

	public getOctokit(remote: Remote): Octokit {
		const hub = this.getHub(remote);
		return hub && hub.octokit;
	}

	public getGraphQL(remote: Remote) {
		const hub = this.getHub(remote);
		return hub && hub.graphql;
	}

	public async loginWithConfirmation(remote: Remote): Promise<GitHub> {
		const normalizedUri = remote.gitProtocol.normalizeUri();
		const result = await vscode.window.showInformationMessage(
			`In order to use the Pull Requests functionality, you need to sign in to ${normalizedUri.authority}`,
			SIGNIN_COMMAND);

		if (result === SIGNIN_COMMAND) {
			return await this.login(remote);
		} else {
			// user cancelled sign in, remember that and don't ask again
			this._octokits.set(`${normalizedUri.scheme}://${normalizedUri.authority}`, undefined);
			this._telemetry.on('auth.cancel');
		}
	}

	public async login(remote: Remote): Promise<GitHub> {
		this._telemetry.on('auth.start');

		// the remote url might be http[s]/git/ssh but we always go through https for the api
		// so use a normalized http[s] url regardless of the original protocol
		const { scheme, authority } = remote.gitProtocol.normalizeUri();
		const host = `${scheme}://${authority}`;

		let retry: boolean = true;
		let octokit: GitHub;
		const server = new GitHubServer(host);

		while (retry) {
			try {
				this.willStartLogin(authority);
				const login = await server.login();
				if (login) {
					octokit = this.createHub(login);
					await setToken(login.host, login.token, { emit: false });
					vscode.window.showInformationMessage(`You are now signed in to ${authority}`);
				}
			} catch (e) {
				Logger.appendLine(`Error signing in to ${authority}: ${e}`);
				if (e instanceof Error) {
					Logger.appendLine(e.stack);
				}
			} finally {
				this.didEndLogin(authority);
			}

			if (octokit) {
				retry = false;
			} else if (retry) {
				retry = (await vscode.window.showErrorMessage(`Error signing in to ${authority}`, TRY_AGAIN)) === TRY_AGAIN;
			}
		}

		if (octokit) {
			this._octokits.set(host, octokit);
			this._telemetry.on('auth.success');
		} else {
			this._telemetry.on('auth.fail');
		}

		this.updateAuthenticationStatusBar(remote);

		return octokit;
	}

	public isCurrentUser(username: string, remote: Remote): boolean {
		const octokit = this.getOctokit(remote);
		return octokit && (octokit as any).currentUser && (octokit as any).currentUser.login === username;
	}

	private createHub(creds: IHostConfiguration): GitHub {
		const baseUrl = `${HostHelper.getApiHost(creds).toString().slice(0, -1)}${HostHelper.getApiPath(creds, '')}`;
		const octokit = new Octokit({
			agent,
			baseUrl,
			headers: { 'user-agent': 'GitHub VSCode Pull Requests' }
		});

		octokit.authenticate({
			type: 'token',
			token: creds.token,
		});

		return {
			octokit,
			graphql: new ApolloClient({
				link: link(baseUrl, creds.token),
				cache: new InMemoryCache,
				defaultOptions: {
					query: {
						fetchPolicy: 'no-cache'
					}
				}
			})
		};
	}

	private async updateStatusBarItem(statusBarItem: vscode.StatusBarItem, remote: Remote): Promise<void> {
		const octokit = this.getOctokit(remote);
		let text: string;
		let command: string;

		if (octokit) {
			try {
				const user = await octokit.users.get({});
				(octokit as any).currentUser = user.data;
				text = `$(mark-github) ${user.data.login}`;
			} catch (e) {
				text = '$(mark-github) Signed in';
			}

			command = null;
		} else {
			const authority = remote.gitProtocol.normalizeUri().authority;
			text = `$(mark-github) Sign in to ${authority}`;
			command = 'pr.signin';
		}

		statusBarItem.text = text;
		statusBarItem.command = command;
	}

	private willStartLogin(authority: string): void {
		const status = this._authenticationStatusBarItems.get(authority);
		status.text = `$(mark-github) Signing in to ${authority}...`;
		status.command = AUTH_INPUT_TOKEN_CMD;
	}

	private didEndLogin(authority: string): void {
		const status = this._authenticationStatusBarItems.get(authority);
		status.text = `$(mark-github) Signed in to ${authority}`;
		status.command = null;
	}

	private async updateAuthenticationStatusBar(remote: Remote): Promise<void> {
		const authority = remote.gitProtocol.normalizeUri().authority;
		const statusBarItem = this._authenticationStatusBarItems.get(authority);
		if (statusBarItem) {
			await this.updateStatusBarItem(statusBarItem, remote);
		} else {
			const newStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
			this._authenticationStatusBarItems.set(authority, newStatusBarItem);

			await this.updateStatusBarItem(newStatusBarItem, remote);
			newStatusBarItem.show();
		}
	}

}

const link = (url: string, token: string) =>
	setContext((_, { headers }) => (({
		headers: {
			...headers,
			authorization: token ? `Bearer ${token}` : '',
		}
	}))).concat(createHttpLink({
		uri: `${url}/graphql`,
		fetch
	}));