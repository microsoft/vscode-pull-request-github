/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AuthProvider, GitHubServerType } from './authentication';
import { Protocol } from './protocol';
import { Repository } from '../api/api';
import { getEnterpriseUri, isEnterprise } from '../github/utils';
import Logger from './logger';

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

/**
 * Resolves git URL aliases by applying insteadOf substitutions from git config.
 * For example, if git config has:
 *   [url "git@github.com:"]
 *     insteadOf = "gh:"
 * Then "gh:user/repo" will be resolved to "git@github.com:user/repo"
 *
 * @param url The URL to resolve
 * @param repository The repository to get config from
 * @returns The resolved URL, or the original URL if no substitution found
 */
async function resolveGitUrl(url: string, repository: Repository): Promise<string> {
	try {
		// Get all git config entries
		const configs = await repository.getConfigs();

		// Find all url.*.insteadOf entries
		const urlSubstitutions: { prefix: string; replacement: string }[] = [];

		for (const config of configs) {
			// Match patterns like "url.https://github.com/.insteadOf" or "url.git@github.com:.insteadOf"
			const match = config.key.match(/^url\.(.+)\.insteadof$/i);
			if (match) {
				const replacement = match[1];
				const prefix = config.value;
				urlSubstitutions.push({ prefix, replacement });
			}
		}

		// Sort by prefix length (longest first) to handle overlapping prefixes correctly
		urlSubstitutions.sort((a, b) => b.prefix.length - a.prefix.length);

		// Apply the first matching substitution
		for (const { prefix, replacement } of urlSubstitutions) {
			if (url.startsWith(prefix)) {
				const resolvedUrl = replacement + url.substring(prefix.length);
				Logger.debug(`Resolved git URL alias: "${url}" -> "${resolvedUrl}"`, 'Remote');
				return resolvedUrl;
			}
		}
	} catch (error) {
		Logger.debug(`Failed to resolve git URL aliases for "${url}": ${error}`, 'Remote');
	}

	// No substitution found or error occurred, return original URL
	return url;
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

/**
 * Asynchronously parses repository remotes with git URL alias resolution.
 * This version resolves git URL aliases (e.g., "gh:" -> "git@github.com:") before parsing.
 * Use this version when you need accurate remote parsing with alias resolution.
 *
 * @param repository The repository to parse remotes from
 * @returns Promise resolving to array of Remote objects
 */
export async function parseRepositoryRemotesAsync(repository: Repository): Promise<Remote[]> {
	const remotes: Remote[] = [];
	for (const r of repository.state.remotes) {
		const urls: string[] = [];
		if (r.fetchUrl) {
			// Resolve git URL aliases before parsing
			const resolvedUrl = await resolveGitUrl(r.fetchUrl, repository);
			urls.push(resolvedUrl);
		}
		if (r.pushUrl && r.pushUrl !== r.fetchUrl) {
			// Resolve git URL aliases before parsing
			const resolvedUrl = await resolveGitUrl(r.pushUrl, repository);
			urls.push(resolvedUrl);
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