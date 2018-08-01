/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as Octokit from '@octokit/rest';
import { fill } from 'git-credential-node';
import * as vscode from 'vscode';
import { Configuration, IHostConfiguration } from '../authentication/configuration';
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
		const host = vscode.Uri.parse(`${normalizedUri.scheme}://${normalizedUri.authority}`);
		const hostString = host.toString();

		// for authentication purposes only the host portion matters
		if (this._octokits.has(hostString)) {
			return this._octokits.get(hostString);
		}
		let octokit: Octokit;

		const webflow = new WebFlow(normalizedUri.authority);
		const creds: IHostConfiguration = this._configuration;
		if (creds.token && await webflow.validate(creds)) {
			octokit = this.createOctokit('token', hostString, creds);
		} else {
			const data = await fill(host.toString());
			if (data) {
				const newCreds = { host: creds.host, username: data.username, token: data.password };
				if (await webflow.validate(newCreds)) {
					octokit = this.createOctokit('token', hostString, newCreds)
					this._configuration.update(newCreds.username, newCreds.token, false);
				}
			}

			const result = await vscode.window.showInformationMessage(`In order to use the Pull Requests functionality, you need to sign in to ${normalizedUri.authority}`,
				SIGNIN_COMMAND);
			if (result === SIGNIN_COMMAND) {
				webflow.login()
					.then(login => {
						octokit = this.createOctokit('token', hostString, login.hostConfiguration)
						this._configuration.update(login.hostConfiguration.username, login.hostConfiguration.token, false);
					})
					.catch(reason => {
						vscode.window.showErrorMessage(`Error signing in to ${normalizedUri.authority}: ${reason}`);
					});
			}
		}

		if (!octokit) {

			// anonymous access, not guaranteed to work for everything, and rate limited
			if (await webflow.checkAnonymousAccess()) {
				vscode.window.showWarningMessage(`Not signed in to ${normalizedUri.authority}. Some functionality may fail.`)
				octokit = this.createOctokit('token', hostString);

			// the server does not support anonymous access, disable everything
			} else {
				vscode.window.showWarningMessage(`Not signed in to ${normalizedUri.authority}. Pull Requests functionality won't work.`)
			}
		}

		this._octokits.set(hostString, octokit);
		return octokit;
	}

	private createOctokit(type: string, url: string, creds?: IHostConfiguration): Octokit {
		const octokit = new Octokit();
		if (creds) {
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
