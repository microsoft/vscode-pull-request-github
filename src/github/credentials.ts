/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as Octokit from '@octokit/rest';
import { fill } from 'git-credential-node';
import * as vscode from 'vscode';
import { IHostConfiguration, HostHelper } from '../authentication/configuration';
import { GitHubServer } from '../authentication/githubServer';
import { Remote } from '../common/remote';
import { VSCodeConfiguration } from '../authentication/vsConfiguration';
import Logger from '../common/logger';

const TRY_AGAIN = 'Try again?';

export class CredentialStore {
	private _octokits: Map<string, Octokit>;
	private _configuration: VSCodeConfiguration;
	constructor(configuration: any) {
		this._configuration = configuration;
		this._octokits = new Map<string, Octokit>();
	}

	public reset() {
		this._octokits = new Map<string, Octokit>();
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
			} else {
				this._configuration.removeHost(creds.host);
			}
		}

		if (!octokit) {
			// see if the system keychain has something we can use
			const data = await fill(host);
			if (data) {
				const login = await server.validate(data.username, data.password);
				if (login) {
					octokit = this.createOctokit('token', login)
					this._configuration.update(login.username, login.token, false);
				}
			}
		}

		if (octokit) {
			this._octokits.set(host, octokit);
		}

		return this._octokits.has(host);
	}

	public getOctokit(remote: Remote): Octokit {
		const normalizedUri = remote.gitProtocol.normalizeUri();
		const host = `${normalizedUri.scheme}://${normalizedUri.authority}`;
		return this._octokits.get(host);
	}

	public async login(remote: Remote): Promise<Octokit> {
		// the remote url might be http[s]/git/ssh but we always go through https for the api
		// so use a normalized http[s] url regardless of the original protocol
		const normalizedUri = remote.gitProtocol.normalizeUri();
		const host = `${normalizedUri.scheme}://${normalizedUri.authority}`;

		let retry: boolean = true;
		let octokit: Octokit;
		const server = new GitHubServer(host);

		while (retry) {
			let error: string;

			try {
				const login = await server.login();
				if (login) {
					octokit = this.createOctokit('token', login)
					this._configuration.update(login.username, login.token, false);
					vscode.window.showInformationMessage(`You are now signed in to ${normalizedUri.authority}`);
				}
			} catch (e) {
				error = e;
			}

			if (octokit) {
				retry = false;
			} else if (retry) {
				Logger.appendLine(`Error signing in to ${normalizedUri.authority}: ${error}`);
				retry = (await vscode.window.showErrorMessage(`Error signing in to ${normalizedUri.authority}`, TRY_AGAIN)) === TRY_AGAIN;
			}
		}

		if (octokit) {
			this._octokits.set(host, octokit);
		}
		return octokit;
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
			}
			else {
				octokit.authenticate({
					type: 'basic',
					username: creds.username,
					password: creds.token,
				});
			}
		}
		return octokit;
	}
}
