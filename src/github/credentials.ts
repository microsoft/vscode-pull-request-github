/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Configuration } from '../configuration';
import { Remote } from '../common/remote';
import { fill } from 'git-credential-node';
const Octokit = require('@octokit/rest');

export class CredentialStore {
	private _octokits: { [key: string]: any };
	private _configuration: Configuration;
	constructor(configuration: Configuration) {
		this._configuration = configuration;
		this._octokits = [];
	}

	async getOctokit(remote: Remote) {
		if (this._octokits[remote.url]) {
			return this._octokits[remote.url];
		}

		if (this._configuration.host === remote.host && this._configuration.accessToken) {
			this._octokits[remote.url] = Octokit({});
			this._octokits[remote.url].authenticate({
				type: 'token',
				token: this._configuration.accessToken
			});
			return this._octokits[remote.url];
		} else {
			const data = await fill(remote.url);
			if (!data) {
				return null;
			}
			this._octokits[remote.url] = Octokit({});
			this._octokits[remote.url].authenticate({
				type: 'basic',
				username: data.username,
				password: data.password
			});

			return this._octokits[remote.url];
		}
	}
}
