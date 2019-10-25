/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import Octokit = require('@octokit/rest');
import { ApolloClient, InMemoryCache, NormalizedCacheObject, gql } from 'apollo-boost';
import { setContext } from 'apollo-link-context';
import * as vscode from 'vscode';
import { agent } from '../common/net';
import { IHostConfiguration, HostHelper } from '../authentication/configuration';
import { GitHubServer } from '../authentication/githubServer';
import { getToken, setToken } from '../authentication/keychain';
import { Remote } from '../common/remote';
import Logger from '../common/logger';
import * as PersistentState from '../common/persistentState';
import { handler as uriHandler } from '../common/uri';
import { createHttpLink } from 'apollo-link-http';
import fetch from 'node-fetch';
import { ITelemetry } from '../common/telemetry';

const TRY_AGAIN = 'Try again?';
const SIGNIN_COMMAND = 'Sign in';
const IGNORE_COMMAND = 'Don\'t show again';

const PROMPT_FOR_SIGN_IN_SCOPE = 'prompt for sign in';
const AUTH_INPUT_TOKEN_CMD = 'auth.inputTokenCallback';

export interface GitHub {
	octokit: Octokit;
	graphql: ApolloClient<NormalizedCacheObject> | null;
}

export class CredentialStore implements vscode.Disposable {
	private _subs: vscode.Disposable[];
	private _octokits: Map<string, GitHub | undefined>;
	private _authenticationStatusBarItems: Map<string, vscode.StatusBarItem>;

	constructor(private readonly _telemetry: ITelemetry) {
		this._subs = [];
		this._octokits = new Map<string, GitHub>();
		this._authenticationStatusBarItems = new Map<string, vscode.StatusBarItem>();
		this._subs.push(vscode.commands.registerCommand(AUTH_INPUT_TOKEN_CMD, async () => {
			const uriOrToken = await vscode.window.showInputBox({ prompt: 'Token', ignoreFocusOut: true });
			if (!uriOrToken) { return; }
			try {
				const uri = vscode.Uri.parse(uriOrToken);
				if (!uri.scheme || uri.scheme === 'file') { throw new Error; }
				uriHandler.handleUri(uri);
			} catch (error) {
				// If it doesn't look like a URI, treat it as a token.
				const host = await vscode.window.showInputBox({ prompt: 'Server', ignoreFocusOut: true, placeHolder: 'github.com' });
				if (!host) { return; }
				setToken(host, uriOrToken);
			}
		}));
	}

	public reset() {
		this._octokits = new Map<string, GitHub>();

		this._authenticationStatusBarItems.forEach(statusBarItem => statusBarItem.dispose());
		this._authenticationStatusBarItems = new Map<string, vscode.StatusBarItem>();
	}

	public async hasOctokit(remote: Remote): Promise<boolean> {
		// the remote url might be http[s]/git/ssh but we always go through https for the api
		// so use a normalized http[s] url regardless of the original protocol
		const normalizedUri = remote.gitProtocol.normalizeUri()!;
		const host = `${normalizedUri.scheme}://${normalizedUri.authority}`;

		if (this._octokits.has(host)) {
			return true;
		}

		const server = new GitHubServer(host);
		const token = await getToken(host);
		let octokit: GitHub | undefined = undefined;

		if (token) {
			if (await server.validate(token)) {
				octokit = await this.createHub({ host, token });
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

	public getHub(remote: Remote): GitHub | undefined {
		const normalizedUri = remote.gitProtocol.normalizeUri()!;
		const host = `${normalizedUri.scheme}://${normalizedUri.authority}`;
		return this._octokits.get(host);
	}

	public getOctokit(remote: Remote): Octokit | undefined {
		const hub = this.getHub(remote);
		return hub && hub.octokit;
	}

	public getGraphQL(remote: Remote) {
		const hub = this.getHub(remote);
		return hub && hub.graphql;
	}

	public async loginWithConfirmation(remote: Remote): Promise<GitHub | undefined> {
		const normalizedUri = remote.gitProtocol.normalizeUri()!;
		const storageKey = `${normalizedUri.scheme}://${normalizedUri.authority}`;

		if (PersistentState.fetch(PROMPT_FOR_SIGN_IN_SCOPE, storageKey) === false) {
			return;
		}

		const result = await vscode.window.showInformationMessage(
			`In order to use the Pull Requests functionality, you must sign in to ${normalizedUri.authority}`,
			SIGNIN_COMMAND, IGNORE_COMMAND);

		if (result === SIGNIN_COMMAND) {
			return await this.login(remote);
		} else {
			this._octokits.set(storageKey, undefined);
			// user cancelled sign in, remember that and don't ask again
			PersistentState.store(PROMPT_FOR_SIGN_IN_SCOPE, storageKey, false);

			/* __GDPR__
				"auth.cancel" : {}
			*/
			this._telemetry.sendTelemetryEvent('auth.cancel');
		}
	}

	public async login(remote: Remote): Promise<GitHub | undefined> {

		/* __GDPR__
			"auth.start" : {}
		*/
		this._telemetry.sendTelemetryEvent('auth.start');

		// the remote url might be http[s]/git/ssh but we always go through https for the api
		// so use a normalized http[s] url regardless of the original protocol
		const { scheme, authority } = remote.gitProtocol.normalizeUri()!;
		const host = `${scheme}://${authority}`;

		let retry: boolean = true;
		let octokit: GitHub | undefined = undefined;
		const server = new GitHubServer(host);

		while (retry) {
			try {
				this.willStartLogin(authority);
				const login = await server.login();
				if (login && login.token) {
					octokit = await this.createHub(login);
					await setToken(login.host, login.token);
				}
			} catch (e) {
				Logger.appendLine(`Error signing in to ${authority}: ${e}`);
				if (e instanceof Error && e.stack) {
					Logger.appendLine(e.stack);
				}
			} finally {
				this.didEndLogin(authority);
			}

			if (octokit) {
				retry = false;
			} else {
				retry = (await vscode.window.showErrorMessage(`Error signing in to ${authority}`, TRY_AGAIN)) === TRY_AGAIN;
			}
		}

		if (octokit) {
			this._octokits.set(host, octokit);

			/* __GDPR__
				"auth.success" : {}
			*/
			this._telemetry.sendTelemetryEvent('auth.success');
		} else {
			/* __GDPR__
				"auth.fail" : {}
			*/
			this._telemetry.sendTelemetryEvent('auth.fail');
		}

		this.updateAuthenticationStatusBar(remote);

		return octokit;
	}

	public isCurrentUser(username: string, remote: Remote): boolean {
		const octokit = this.getOctokit(remote);
		return octokit && (octokit as any).currentUser && (octokit as any).currentUser.login === username;
	}

	public getCurrentUser(remote: Remote): Octokit.PullsGetResponseUser {
		const octokit = this.getOctokit(remote);
		return octokit && (octokit as any).currentUser;
	}

	private async createHub(creds: IHostConfiguration): Promise<GitHub> {
		const baseUrl = `${HostHelper.getApiHost(creds).toString().slice(0, -1)}${HostHelper.getApiPath(creds, '')}`;
		const octokit = new Octokit({
			request: { agent },
			baseUrl,
			userAgent: 'GitHub VSCode Pull Requests',
			// `shadow-cat-preview` is required for Draft PR API access -- https://developer.github.com/v3/previews/#draft-pull-requests
			previews: ['shadow-cat-preview'],
			auth() {
				return `token ${creds.token || ''}`;
			}
		});

		const graphql = new ApolloClient({
			link: link(baseUrl, creds.token || ''),
			cache: new InMemoryCache,
			defaultOptions: {
				query: {
					fetchPolicy: 'no-cache'
				}
			}
		});

		let supportsGraphQL = true;
		await graphql.query({ query: gql`query { viewer { login } }` })
			.then(result => {
				Logger.appendLine(`${baseUrl}: GraphQL support detected`);

				/* __GDPR__
					"auth.graphql.supported" : {}
				*/
				this._telemetry.sendTelemetryEvent('auth.graphql.supported');
			})
			.catch(err => {
				Logger.appendLine(`${baseUrl}: GraphQL not supported (${err.message})`);
				/* __GDPR__
					"auth.graphql.unsupported" : {}
				*/
				this._telemetry.sendTelemetryEvent('auth.graphql.unsupported');
				supportsGraphQL = false;
			});

		return {
			octokit,
			graphql: supportsGraphQL ? graphql : null,
		};
	}

	private async updateStatusBarItem(statusBarItem: vscode.StatusBarItem, remote: Remote): Promise<void> {
		const octokit = this.getOctokit(remote);
		let text: string;
		let command: string | undefined;

		if (octokit) {
			try {
				const user = await octokit.users.getAuthenticated({});
				(octokit as any).currentUser = user.data;
				text = `$(mark-github) ${user.data.login}`;
			} catch (e) {
				text = '$(mark-github) Signed in';
			}
			command = 'pr.configurePRViewlet';
			// Temporarily show successful sign-in status
			statusBarItem.text = '$(mark-github) Successfully signed in';
			setTimeout(async () => {
				statusBarItem.text = text;
			}, 2000);
		} else {
			const authority = remote.gitProtocol.normalizeUri()!.authority;
			text = `$(mark-github) Sign in to ${authority}`;
			command = 'pr.signin';
			statusBarItem.text = text;
		}
		statusBarItem.command = command;
	}

	private willStartLogin(authority: string): void {
		const status = this._authenticationStatusBarItems.get(authority);
		if (status) {
			status.text = `$(mark-github) Signing in to ${authority}...`;
			status.command = AUTH_INPUT_TOKEN_CMD;
		}
	}

	private didEndLogin(authority: string): void {
		const status = this._authenticationStatusBarItems.get(authority)!;
		if (status) {
			status.text = `$(mark-github) Signed in to ${authority}`;
			status.command = undefined;
		}
	}

	private async updateAuthenticationStatusBar(remote: Remote): Promise<void> {
		const authority = remote.gitProtocol.normalizeUri()!.authority;
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

	dispose() {
		this._subs.forEach(sub => sub.dispose());
	}
}

const link = (url: string, token: string) =>
	setContext((_, { headers }) => (({
		headers: {
			...headers,
			authorization: token ? `Bearer ${token}` : '',
			Accept: 'application/vnd.github.shadow-cat-preview+json'
		}
	}))).concat(createHttpLink({
		uri: `${url}/graphql`,
		// https://github.com/apollographql/apollo-link/issues/513
		fetch: fetch as any
	}));