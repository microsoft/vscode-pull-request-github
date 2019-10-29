import * as https from 'https';
import * as vscode from 'vscode';
import Logger from '../common/logger';
import { agent } from '../common/net';
import { handler as uriHandler } from '../common/uri';
import { PromiseAdapter, promiseFromEvent } from '../common/utils';
import { HostHelper, IHostConfiguration } from './configuration';
import { listHosts, onDidChange as onKeychainDidChange, toCanonical } from './keychain';
import uuid = require('uuid');
import { EXTENSION_ID } from '../constants';

const SCOPES: string = 'read:user user:email repo write:discussion';
const GHE_OPTIONAL_SCOPES: { [key: string]: boolean } = { 'write:discussion': true };

const AUTH_RELAY_SERVER = 'vscode-auth.github.com';

export class GitHubManager {
	private _servers: Map<string, boolean> = new Map().set('github.com', true);

	private static GitHubScopesTable: { [key: string]: string[] } = {
		repo: ['repo:status', 'repo_deployment', 'public_repo', 'repo:invite'],
		'admin:org': ['write:org', 'read:org'],
		'admin:public_key': ['write:public_key', 'read:public_key'],
		'admin:org_hook': [],
		gist: [],
		notifications: [],
		user: ['read:user', 'user:email', 'user:follow'],
		delete_repo: [],
		'write:discussion': ['read:discussion'],
		'admin:gpg_key': ['write:gpg_key', 'read:gpg_key']
	};

	public static AppScopes: string[] = SCOPES.split(' ');

	public async isGitHub(host: vscode.Uri): Promise<boolean> {
		if (host === null) {
			return false;
		}

		if (this._servers.has(host.authority)) {
			return !!this._servers.get(host.authority);
		}

		const keychainHosts = await listHosts();
		if (keychainHosts.indexOf(toCanonical(host.authority)) !== -1) {
			return true;
		}

		const options = GitHubManager.getOptions(host, 'HEAD', '/rate_limit');
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

	public static getOptions(hostUri: vscode.Uri, method: string = 'GET', path: string, token?: string) {
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
			host: HostHelper.getApiHost(hostUri).authority,
			port: 443,
			method,
			path: HostHelper.getApiPath(hostUri, path),
			headers,
			agent,
		};
	}

	public static validateScopes(host: vscode.Uri, scopes: string): boolean {
		if (!scopes) {
			Logger.appendLine(`[SKIP] validateScopes(${host.toString()}): No scopes available.`);
			return true;
		}
		const tokenScopes = scopes.split(', ');
		const scopesNotFound = this.AppScopes.filter(x => !(
			tokenScopes.indexOf(x) >= 0 ||
			tokenScopes.indexOf(this.getScopeSuperset(x)) >= 0 ||
			// some scopes don't exist on older versions of GHE, treat them as optional
			(this.isDotCom(host) || GHE_OPTIONAL_SCOPES[x])
		));
		if (scopesNotFound.length) {
			Logger.appendLine(`[FAIL] validateScopes(${host.toString()}): ${scopesNotFound.length} scopes missing`);
			scopesNotFound.forEach(scope => Logger.appendLine(`   - ${scope}`));
			return false;
		}
		return true;
	}

	private static getScopeSuperset(scope: string): string {
		for (const key in this.GitHubScopesTable) {
			if (this.GitHubScopesTable[key].indexOf(scope) >= 0) {
				return key;
			}
		}
		return scope;
	}

	private static isDotCom(host: vscode.Uri): boolean {
		return host && host.authority.toLowerCase() === 'github.com';
	}
}

const exchangeCodeForToken: (host: string, state: string) => PromiseAdapter<vscode.Uri, IHostConfiguration> =
	(host, state) => async (uri, resolve, reject) => {
		const query = parseQuery(uri);
		const code = query.code;

		if (query.state !== state) {
			vscode.window.showInformationMessage('Sign in failed: Received bad state');
			reject('Received bad state');
			return;
		}

		const post = https.request({
			host: AUTH_RELAY_SERVER,
			path: `/token?code=${code}&state=${query.state}`,
			method: 'POST',
			headers: {
				Accept: 'application/json'
			}
		}, result => {
			const buffer: Buffer[] = [];
			result.on('data', (chunk: Buffer) => {
				buffer.push(chunk);
			});
			result.on('end', () => {
				if (result.statusCode === 200) {
					const json = JSON.parse(Buffer.concat(buffer).toString());
					resolve({ host, token: json.access_token });
				} else {
					vscode.window.showInformationMessage(`Sign in failed: ${result.statusMessage}`);
					reject(new Error(result.statusMessage));
				}
			});
		});

		post.end();
		post.on('error', err => {
			reject(err);
		});
	};

function parseQuery(uri: vscode.Uri) {
	return uri.query.split('&').reduce((prev: any, current) => {
		const queryString = current.split('=');
		prev[queryString[0]] = queryString[1];
		return prev;
	}, {});
}

const manuallyEnteredToken: (host: string) => PromiseAdapter<IHostConfiguration, IHostConfiguration> =
	host => (config: IHostConfiguration, resolve) =>
		config.host === toCanonical(host) && resolve(config);

export class GitHubServer {
	public hostConfiguration: IHostConfiguration;
	private hostUri: vscode.Uri;

	public constructor(host: string) {
		host = host.toLocaleLowerCase();
		this.hostConfiguration = { host, token: undefined };
		this.hostUri = vscode.Uri.parse(host);
	}

	public async login(): Promise<IHostConfiguration> {
		const state = uuid();
		const callbackUri = await vscode.env.asExternalUri(vscode.Uri.parse(`${vscode.env.uriScheme}://${EXTENSION_ID}/did-authenticate`));
		const host = this.hostUri.toString();
		const uri = vscode.Uri.parse(`https://${AUTH_RELAY_SERVER}/authorize/?callbackUri=${encodeURIComponent(callbackUri.toString())}&scope=${SCOPES}&state=${state}&responseType=code&authServer=${host}`);

		vscode.env.openExternal(uri);
		return Promise.race([
			promiseFromEvent(uriHandler.event, exchangeCodeForToken(host, state)),
			promiseFromEvent(onKeychainDidChange, manuallyEnteredToken(host))
		]);
	}

	public async validate(token?: string): Promise<IHostConfiguration> {
		if (!token) {
			token = this.hostConfiguration.token;
		}

		const options = GitHubManager.getOptions(this.hostUri, 'GET', '/user', token);

		return new Promise<IHostConfiguration>((resolve, _) => {
			const get = https.request(options, res => {
				try {
					if (res.statusCode === 200) {
						const scopes = res.headers['x-oauth-scopes'] as string;
						GitHubManager.validateScopes(this.hostUri, scopes);
						resolve(this.hostConfiguration);
					} else {
						resolve(undefined);
					}
				} catch (e) {
					Logger.appendLine(`validate() error ${e}`);
					resolve(undefined);
				}
			});

			get.end();
			get.on('error', err => {
				resolve(undefined);
			});
		});
	}
}
