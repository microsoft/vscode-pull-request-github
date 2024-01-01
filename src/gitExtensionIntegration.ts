/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RemoteSource, RemoteSourceProvider } from './@types/git';
import { AuthProvider } from './common/authentication';
import { OctokitCommon } from './github/common';
import { CredentialStore, GitHub } from './github/credentials';
import { isEnterprise } from './github/utils';

interface Repository {
	readonly full_name: string;
	readonly description: string | null;
	readonly clone_url: string;
	readonly ssh_url: string;
}

function repoResponseAsRemoteSource(raw: OctokitCommon.SearchReposResponseItem): RemoteSource {
	return {
		name: `$(github) ${raw.full_name}`,
		description: raw.description || undefined,
		url: raw.url,
	};
}

function asRemoteSource(raw: Repository): RemoteSource {
	return {
		name: `$(github) ${raw.full_name}`,
		description: raw.description || undefined,
		url: raw.clone_url,
	};
}

export class GithubRemoteSourceProvider implements RemoteSourceProvider {
	readonly name: string = 'GitHub';
	readonly icon = 'github';
	readonly supportsQuery = true;

	private userReposCache: RemoteSource[] = [];

	constructor(private readonly credentialStore: CredentialStore, private readonly authProviderId: AuthProvider = AuthProvider.github) {
		if (isEnterprise(authProviderId)) {
			this.name = 'GitHub Enterprise';
		}
	}

	async getRemoteSources(query?: string): Promise<RemoteSource[]> {
		const hub = await this.credentialStore.getHubOrLogin(this.authProviderId);

		if (!hub) {
			throw new Error('Could not fetch repositories from GitHub.');
		}

		const [fromUser, fromQuery] = await Promise.all([
			this.getUserRemoteSources(hub, query),
			this.getQueryRemoteSources(hub, query),
		]);

		const userRepos = new Set(fromUser.map(r => r.name));

		return [...fromUser, ...fromQuery.filter(r => !userRepos.has(r.name))];
	}

	private async getUserRemoteSources(hub: GitHub, query?: string): Promise<RemoteSource[]> {
		if (!query) {
			const res = await hub.octokit.call(hub.octokit.api.repos.listForAuthenticatedUser, { sort: 'pushed', per_page: 100 });
			this.userReposCache = res.data.map(asRemoteSource);
		}

		return this.userReposCache;
	}

	private async getQueryRemoteSources(hub: GitHub, query?: string): Promise<RemoteSource[]> {
		if (!query) {
			return [];
		}

		const raw = await hub.octokit.call(hub.octokit.api.search.repos, { q: query, sort: 'updated' });
		return raw.data.items.map(repoResponseAsRemoteSource);
	}
}
