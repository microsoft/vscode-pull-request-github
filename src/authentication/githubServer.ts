/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import fetch from 'cross-fetch';
import * as vscode from 'vscode';
import { GitHubServerType } from '../common/authentication';
import Logger from '../common/logger';
import { agent } from '../env/node/net';
import { HostHelper } from './configuration';

export class GitHubManager {
	private static readonly _githubDotComServers = new Set<string>().add('github.com').add('ssh.github.com');
	private _servers: Map<string, GitHubServerType> = new Map(Array.from(GitHubManager._githubDotComServers.keys()).map(key => [key, GitHubServerType.GitHubDotCom]));

	public static isGithubDotCom(host: string): boolean {
		return this._githubDotComServers.has(host);
	}

	public async isGitHub(host: vscode.Uri): Promise<GitHubServerType> {
		if (host === null) {
			return GitHubServerType.None;
		}

		// .wiki/.git repos are not supported
		if (host.path.endsWith('.wiki') || host.authority.match(/gist[.]github[.]com/)) {
			return GitHubServerType.None;
		}

		if (this._servers.has(host.authority)) {
			return this._servers.get(host.authority) ?? GitHubServerType.None;
		}

		const [uri, options] = await GitHubManager.getOptions(host, 'HEAD', '/rate_limit');

		let isGitHub = GitHubServerType.None;
		try {
			const response = await fetch(uri.toString(), options);
			const gitHubHeader = response.headers.get('x-github-request-id');
			const gitHubEnterpriseHeader = response.headers.get('x-github-enterprise-version');
			isGitHub = ((gitHubHeader !== undefined) && (gitHubHeader !== null)) ? (gitHubEnterpriseHeader ? GitHubServerType.Enterprise : GitHubServerType.GitHubDotCom) : GitHubServerType.None;
			return isGitHub;
		} catch (ex) {
			Logger.appendLine(`No response from host ${host}: ${ex.message}`, 'GitHubServer');
			return isGitHub;
		} finally {
			Logger.debug(`Host ${host} is associated with GitHub: ${isGitHub}`, 'GitHubServer');
			this._servers.set(host.authority, isGitHub);
		}
	}

	public static async getOptions(
		hostUri: vscode.Uri,
		method: string = 'GET',
		path: string,
		token?: string,
	): Promise<[vscode.Uri, RequestInit]> {
		const headers: {
			'user-agent': string;
			authorization?: string;
		} = {
			'user-agent': 'GitHub VSCode Pull Requests',
		};
		if (token) {
			headers.authorization = `token ${token}`;
		}

		const uri = vscode.Uri.joinPath(await HostHelper.getApiHost(hostUri), HostHelper.getApiPath(hostUri, path));
		const requestInit = {
			hostname: uri.authority,
			port: 443,
			method,
			headers,
			agent
		};

		return [
			uri,
			requestInit as RequestInit,
		];
	}
}
