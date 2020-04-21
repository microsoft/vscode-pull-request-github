/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RemoteSourceProvider, RemoteSource } from './typings/git';
import { CredentialStore, GitHub } from './github/credentials';
import { Remote } from './common/remote';
import { Protocol } from './common/protocol';

export class GithubRemoteSourceProvider implements RemoteSourceProvider {

	readonly name = 'GitHub';
	readonly supportsQuery = true;

	constructor(private readonly credentialStore: CredentialStore) {

	}

	async getRemoteSources(query?: string): Promise<RemoteSource[]> {
		const hub = this.getHub();

		if (!hub) {
			return [];
		}

		return [];
	}

	private async getHub(): Promise<GitHub | undefined> {
		// TODO: eventually remove
		const url = 'https://github.com/microsoft/vscode.git';
		const remote = new Remote('origin', url, new Protocol(url));

		if (!await this.credentialStore.hasOctokit(remote)) {
			return await this.credentialStore.loginWithConfirmation(remote);
		} else {
			return await this.credentialStore.getHub(remote);
		}
	}
}