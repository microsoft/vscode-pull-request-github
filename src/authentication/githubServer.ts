import * as https from 'https';
import * as vscode from 'vscode';
import Logger from '../common/logger';
import { agent } from '../env/node/net';
import { HostHelper } from './configuration';

export class GitHubManager {
	private _servers: Map<string, boolean> = new Map().set('github.com', true);

	public async isGitHub(host: vscode.Uri): Promise<boolean> {
		if (host === null) {
			return false;
		}

		if (this._servers.has(host.authority)) {
			return !!this._servers.get(host.authority);
		}

		const options = await GitHubManager.getOptions(host, 'HEAD', '/rate_limit');
		return new Promise<boolean>((resolve, _) => {
			const get = https.request(options, res => {
				const ret = res.headers['x-github-request-id'];
				resolve(ret !== undefined);
			});

			get.end();
			get.on('error', err => {
				Logger.appendLine(`No response from host ${host}: ${err.message}`, 'GitHubServer');
				resolve(false);
			});
		}).then(isGitHub => {
			Logger.debug(`Host ${host} is associated with GitHub: ${isGitHub}`, 'GitHubServer');
			this._servers.set(host.authority, isGitHub);
			return isGitHub;
		});
	}

	public static async getOptions(hostUri: vscode.Uri, method: string = 'GET', path: string, token?: string) {
		const headers: {
			'user-agent': string;
			authorization?: string;
		} = {
			'user-agent': 'GitHub VSCode Pull Requests',
		};
		if (token) {
			headers.authorization = `token ${token}`;
		}

		return {
			host: (await HostHelper.getApiHost(hostUri)).authority,
			port: 443,
			method,
			path: HostHelper.getApiPath(hostUri, path),
			headers,
			agent,
		};
	}
}
