/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Repository } from '../api/api';
import { getEnterpriseUri, isEnterprise } from '../github/utils';
import { AuthProvider, GitHubServerType } from './authentication';
import { Protocol } from './protocol';

export class Remote {
	public get host(): string {
		return this.gitProtocol.host;
	}
	public get owner(): string {
		return this.gitProtocol.owner;
	}
	public get repositoryName(): string {
		return this.gitProtocol.repositoryName;
	}

	public get normalizedHost(): string {
		const normalizedUri = this.gitProtocol.normalizeUri();
		return `${normalizedUri!.scheme}://${normalizedUri!.authority}`;
	}

	public get authProviderId(): AuthProvider {
		return this.host === getEnterpriseUri()?.authority ? AuthProvider.githubEnterprise : AuthProvider.github;
	}

	public get isEnterprise(): boolean {
		return isEnterprise(this.authProviderId);
	}

	constructor(
		public readonly remoteName: string,
		public readonly url: string,
		public readonly gitProtocol: Protocol,
	) { }

	equals(remote: Remote): boolean {
		if (this.remoteName !== remote.remoteName) {
			return false;
		}
		if (!this.host.includes(remote.host) && !remote.host.includes(this.host)) {
			return false;
		}
		if (this.owner.toLocaleLowerCase() !== remote.owner.toLocaleLowerCase()) {
			return false;
		}
		if (this.repositoryName.toLocaleLowerCase() !== remote.repositoryName.toLocaleLowerCase()) {
			return false;
		}

		return true;
	}
}

export function parseRemote(remoteName: string, url: string, originalProtocol?: Protocol): Remote | null {
	if (!url) {
		return null;
	}
	const gitProtocol = new Protocol(url);
	if (originalProtocol) {
		gitProtocol.update({
			type: originalProtocol.type,
		});
	}

	if (gitProtocol.host) {
		return new Remote(remoteName, url, gitProtocol);
	}

	return null;
}

export function parseRepositoryRemotes(repository: Repository): Remote[] {
	const remotes: Remote[] = [];
	for (const r of repository.state.remotes) {
		const urls: string[] = [];
		if (r.fetchUrl) {
			urls.push(r.fetchUrl);
		}
		if (r.pushUrl && r.pushUrl !== r.fetchUrl) {
			urls.push(r.pushUrl);
		}
		urls.forEach(url => {
			const remote = parseRemote(r.name, url);
			if (remote) {
				remotes.push(remote);
			}
		});
	}
	return remotes;
}

export class GitHubRemote extends Remote {
	static remoteAsGitHub(remote: Remote, githubServerType: GitHubServerType): GitHubRemote {
		return new GitHubRemote(remote.remoteName, remote.url, remote.gitProtocol, githubServerType);
	}

	constructor(
		remoteName: string,
		url: string,
		gitProtocol: Protocol,
		public readonly githubServerType: GitHubServerType
	) {
		super(remoteName, url, gitProtocol);
	}
}