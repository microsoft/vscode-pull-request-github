/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as Octokit from '@octokit/rest';
import { fill } from 'git-credential-node';
import * as vscode from 'vscode';
import { Configuration, IHostConfiguration, HostHelper } from '../authentication/configuration';
import { WebFlow } from '../authentication/webflow';
import { Remote } from '../common/remote';

const SIGNIN_COMMAND = 'Sign in';

export class CredentialStore {
	//private _octokits: { [key: string]: Octokit | Promise<Octokit> };
	private _octokits: Map<string, Octokit>;
	private _configuration: Configuration;
	constructor(configuration: Configuration) {
		this._configuration = configuration;
		this._octokits = new Map<string, Octokit>();
	}

	reset() {
		this._octokits = new Map<string, Octokit>();
	}

	async getOctokit(remote: Remote): Promise<Octokit> {
		// the remote url might be http[s]/git/ssh but we always go through https for the api
		// so use a normalized http[s] url regardless of the original protocol
		const normalizedUri = remote.gitProtocol.normalizeUri();
		const host = vscode.Uri.parse(`${normalizedUri.scheme}://${normalizedUri.authority}`).toString();

		// for authentication purposes only the host portion matters
		if (this._octokits.has(host)) {
			return this._octokits.get(host);
		}
		let octokit: Octokit;

		const webflow = new WebFlow(host);
		const creds: IHostConfiguration = this._configuration;
		if (creds.token && await webflow.validate(creds.username, creds.token)) {
			octokit = this.createOctokit('token', creds);
		} else {

			// see if the system keychain has something we can use
			const data = await fill(host);
			if (data) {
				const login = await webflow.validate(data.username, data.password);
				if (login) {
					octokit = this.createOctokit('token', login)
					this._configuration.update(login.username, login.token, false);
				}
			}

			const result = await vscode.window.showInformationMessage(
				`In order to use the Pull Requests functionality, you need to sign in to ${normalizedUri.authority}`,
				SIGNIN_COMMAND);

			if (result === SIGNIN_COMMAND) {
				try {
					const login = await webflow.login();
					if (login) {
						octokit = this.createOctokit('token', login)
						this._configuration.update(login.username, login.token, false);
					}
				} catch (e) {
					vscode.window.showErrorMessage(`Error signing in to ${normalizedUri.authority}: ${e}`);
				}
			} else {
				vscode.window.showErrorMessage(`Error signing in to ${normalizedUri.authority}`);
			}
		}

		if (!octokit) {

			// anonymous access, not guaranteed to work for everything, and rate limited
			if (await webflow.checkAnonymousAccess()) {
				vscode.window.showWarningMessage(`Not signed in to ${normalizedUri.authority}. Some functionality may fail.`)
				octokit = this.createOctokit('token', creds);

				// the server does not support anonymous access, disable everything
			} else {
				vscode.window.showWarningMessage(`Not signed in to ${normalizedUri.authority}. Pull Requests functionality won't work.`)
			}
		}

		this._octokits.set(host, octokit);
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
