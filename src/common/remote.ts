/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { AuthProvider, GitHubServerType } from './authentication';
import Logger from './logger';
import { Protocol, ProtocolType } from './protocol';
import { Repository } from '../api/api';
import { getEnterpriseUris } from '../authentication/configuration';
import { isEnterprise } from '../github/utils';

const GITHUB_DOT_COM_HOSTS = ['github.com', 'ssh.github.com'];

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
		if (this.gitProtocol.type === ProtocolType.HTTP) {
			const uri = this.gitProtocol.url;
			const path = uri.path.replace(/\/$/, '');
			const deploymentPath = path.slice(0, path.lastIndexOf('/', path.lastIndexOf('/') - 1));
			return uri.with({ authority: uri.authority.replace(/^.*@/, ''), path: deploymentPath, query: '', fragment: '' }).toString().replace(/\/$/, '');
		}
		const normalizedUri = this.gitProtocol.normalizeUri();
		return `${normalizedUri!.scheme}://${normalizedUri!.authority}`;
	}

	/**
	 * Classification for a remote whose server type has not been detected. Only hosts that are known to be
	 * GitHub Enterprise (GHE.com or a configured Enterprise instance) are treated as Enterprise; any other
	 * host, including non-GitHub servers, falls back to GitHub.com.
	 */
	public get authProviderId(): AuthProvider {
		const host = this.host.toLowerCase();
		if (GITHUB_DOT_COM_HOSTS.includes(host)) {
			return AuthProvider.github;
		}
		if (host === 'ghe.com' || host.endsWith('.ghe.com')) {
			return AuthProvider.githubEnterprise;
		}
		try {
			if (getEnterpriseUris().some(uri => this.matchesServerUri(uri))) {
				return AuthProvider.githubEnterprise;
			}
		} catch {
			// Invalid Enterprise configuration is reported where the setting is consumed; treat it as unconfigured.
		}
		return AuthProvider.github;
	}

	public get isEnterprise(): boolean {
		return isEnterprise(this.authProviderId);
	}

	constructor(
		public readonly remoteName: string,
		public readonly url: string,
		public readonly gitProtocol: Protocol,
	) { }

	public matchesServerUri(serverUri: vscode.Uri): boolean {
		const server = new URL(serverUri.toString());
		if (server.hostname.toLowerCase() === 'github.com') {
			return GITHUB_DOT_COM_HOSTS.includes(this.host.toLowerCase());
		}
		if (this.gitProtocol.type !== ProtocolType.HTTP) {
			return this.host.toLowerCase() === server.hostname.toLowerCase();
		}
		const remote = new URL(this.normalizedHost);
		return remote.host.toLowerCase() === server.host.toLowerCase()
			&& remote.pathname.replace(/\/$/, '') === server.pathname.replace(/\/$/, '');
	}

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
				Logger.appendLine(`Resolved git URL alias: "${url}" -> "${resolvedUrl}"`, 'Remote');
				return resolvedUrl;
			}
		}
	} catch (error) {
		Logger.error(`Failed to resolve git URL aliases for "${url}": ${error}`, 'Remote');
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
		const githubRemote = new GitHubRemote(remote.remoteName, remote.url, remote.gitProtocol, githubServerType);
		Logger.debug(`Remote "${remote.remoteName}" at ${remote.host} was classified as ${GitHubServerType[githubServerType]} and uses ${githubRemote.authProviderId} authentication.`, 'Remote');
		return githubRemote;
	}

	public override get authProviderId(): AuthProvider {
		if (this.githubServerType === GitHubServerType.Enterprise) {
			return AuthProvider.githubEnterprise;
		}
		if (this.githubServerType === GitHubServerType.GitHubDotCom) {
			return AuthProvider.github;
		}
		return super.authProviderId;
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