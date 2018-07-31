/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Configuration, IHostConfiguration } from '../authentication/configuration';
import { WebFlow } from '../authentication/webflow';
import { Remote } from '../common/remote';
import { fill } from 'git-credential-node';
import { VSCodeAppConfiguration } from '../authentication/vsConfiguration';
const Octokit = require('@octokit/rest');

export class CredentialStore {
	private _octokits: { [key: string]: any };
	private _configuration: Configuration;
	constructor(configuration: Configuration) {
		this._configuration = configuration;
		this._octokits = [];
	}

	reset() {
		this._octokits = [];
	}

	async getOctokit(remote: Remote) {
		if (this._octokits[remote.url]) {
			return this._octokits[remote.url];
		}

		const webflow = new WebFlow(new VSCodeAppConfiguration(), remote.host);
		let creds = this._configuration as IHostConfiguration;
		if (creds.host === remote.host && creds.token && await webflow.validate(creds)) {
			return this.authenticate('token', remote.url, creds);
		} else {
			let data = await fill(remote.url);
			if (data) {
				creds.username = data.username;
				creds.token = data.password;
				if (await webflow.validate(creds)) {
					return this.authenticate('basic', remote.url, creds);
				}
			}

			const login = await webflow.login();

			if (login.authenticated)
			{
				creds = login.host;
				if (creds.host === remote.host) {
					this._configuration.update(creds.username, creds.token);
				}
				return this.authenticate('token', remote.url, creds);
			}
			return null;
		}
	}

	private authenticate(type: string, url: string, creds: IHostConfiguration) {
		this._octokits[url] = Octokit({});
		if (type === 'token') {
			this._octokits[url].authenticate({
				type: 'token',
				token: creds.token,
			});
		}
		else {
			this._octokits[url].authenticate({
				type: 'basic',
				username: creds.username,
				password: creds.token,
			});
		}
		return this._octokits[url];
	}
}
