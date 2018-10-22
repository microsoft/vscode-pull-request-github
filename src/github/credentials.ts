/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as Octokit from '@octokit/rest';
import * as vscode from 'vscode';
import { IHostConfiguration, HostHelper } from '../authentication/configuration';
import { GitHubServer } from '../authentication/githubServer';
import { Remote } from '../common/remote';
import { VSCodeConfiguration } from '../authentication/vsConfiguration';
import Logger from '../common/logger';
import { ITelemetry } from './interface';
import { handler as uriHandler } from '../common/uri';

const TRY_AGAIN = 'Try again?';
const SIGNIN_COMMAND = 'Sign in';

const AUTH_INPUT_TOKEN_CMD = 'auth.inputTokenCallback';

export class CredentialStore {
	private _octokits: Map<string, Octokit>;
	private _logins: Map<string, string>;
	private _configuration: VSCodeConfiguration;
	private _authenticationStatusBarItems: Map<string, vscode.StatusBarItem>;

	constructor(configuration: any,
		private readonly _telemetry: ITelemetry) {
		this._configuration = configuration;
		this._octokits = new Map<string, Octokit>();
		this._logins = new Map<string, string>();
		this._authenticationStatusBarItems = new Map<string, vscode.StatusBarItem>();
		vscode.commands.registerCommand(AUTH_INPUT_TOKEN_CMD, async () => {
			const uriStr = await vscode.window.showInputBox({ prompt: 'Token' });
			if (!uriStr) { return; }
			const uri = vscode.Uri.parse(uriStr);
			if (!uri.scheme) {
				return vscode.window.showErrorMessage('Invalid token');
			}
			uriHandler.handleUri(uri);
		});
	}

	public reset() {
		this._octokits = new Map<string, Octokit>();

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

		this._configuration.setHost(host);

		const creds: IHostConfiguration = this._configuration;
		const server = new GitHubServer(host);
		let octokit: Octokit;

		if (creds.token) {
			if (await server.validate(creds.username, creds.token)) {
				octokit = this.createOctokit('token', creds);
			}
		}

		if (octokit) {
			this._octokits.set(host, octokit);
		}
		await this.updateAuthenticationStatusBar(remote);
		return this._octokits.has(host);
	}

	public getOctokit(remote: Remote): Octokit {
		const normalizedUri = remote.gitProtocol.normalizeUri();
		const host = `${normalizedUri.scheme}://${normalizedUri.authority}`;
		return this._octokits.get(host);
	}

	public getLogin(remote: Remote): string {
		return this._logins.get(remote.normalizedHost);
	}

	public setLogin(remote: Remote, login: string): void {
		this._logins.set(remote.normalizedHost, login);
	}

	public async loginWithConfirmation(remote: Remote): Promise<Octokit> {
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

	public async login(remote: Remote): Promise<Octokit> {
		this._telemetry.on('auth.start');

		// the remote url might be http[s]/git/ssh but we always go through https for the api
		// so use a normalized http[s] url regardless of the original protocol
		const { scheme, authority } = remote.gitProtocol.normalizeUri();
		const host = `${scheme}://${authority}`;

		let retry: boolean = true;
		let octokit: Octokit;
		const server = new GitHubServer(host);

		while (retry) {
			try {
				this.willStartLogin(authority);
				const login = await server.login();
				if (login) {
					octokit = this.createOctokit('token', login);
					await this._configuration.update(login.username, login.token, false);
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
		return username === this.getLogin(remote);
	}

	private createOctokit(type: string, creds: IHostConfiguration): Octokit {
		const octokit = new Octokit({
			baseUrl: `${HostHelper.getApiHost(creds).toString().slice(0, -1)}${HostHelper.getApiPath(creds, '')}`,
			headers: { 'user-agent': 'GitHub VSCode Pull Requests' }
		});

		if (creds.token) {
			if (type === 'token') {
				octokit.authenticate({
					type: 'token',
					token: creds.token,
				});
			} else {
				octokit.authenticate({
					type: 'basic',
					username: creds.username,
					password: creds.token,
				});
			}
		}
		return octokit;
	}

	private async updateStatusBarItem(statusBarItem: vscode.StatusBarItem, remote: Remote): Promise<void> {
		const octokit = this.getOctokit(remote);
		let text: string;
		let command: string;

		if (octokit) {
			try {
				const user = await octokit.users.get({});
				text = `$(mark-github) ${user.data.login}`;
				this.setLogin(remote, user.data.login);
			} catch (e) {
				text = '$(mark-github) Signed in';
				this.setLogin(remote, undefined);
			}

			command = null;
		} else {
			const authority = remote.gitProtocol.normalizeUri().authority;
			text = `$(mark-github) Sign in to ${authority}`;
			command = 'pr.signin';
			this.setLogin(remote, undefined);
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
