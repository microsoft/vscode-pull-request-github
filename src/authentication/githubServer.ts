import * as vscode from 'vscode';
import { IHostConfiguration, HostHelper } from './configuration';
import * as https from 'https';
import Logger from '../common/logger';
import { handler as uriHandler } from '../common/uri';
import axios from 'axios';
const SCOPES: string = 'read:user user:email repo write:discussion';
const GHE_OPTIONAL_SCOPES: object = {'write:discussion': true};

// const AUTH_RELAY_SERVER = 'http://localhost:55555'
// const AUTH_RELAY_SERVER = 'https://client-auth-staging-14a768b.herokuapp.com'
const AUTH_RELAY_SERVER = 'https://vscode-auth.github.com'
const EXTENSION_ID = 'GitHub.vscode-pull-request-github'
const CALLBACK_PATH = '/did-authenticate'
const CALLBACK_URI = vscode.version.endsWith('-insider')
	? `vscode-insiders://${EXTENSION_ID}${CALLBACK_PATH}`
	: `vscode://${EXTENSION_ID}${CALLBACK_PATH}`
const MAX_TOKEN_RESPONSE_AGE = 5 * (1000 * 60 /* minutes in ms */)

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
			return this._servers.get(host.authority);
		}

		const options = GitHubManager.getOptions(host, 'HEAD', '/rate_limit');
		return new Promise<boolean>((resolve, _) => {
			const get = https.request(options, res => {
				const ret = res.headers['x-github-request-id'];
				resolve(ret !== undefined);
			});

			get.end();
			get.on('error', err => {
				resolve(false);
			});
		}).then(isGitHub => {
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
		};
	}

	public static validateScopes(host: vscode.Uri, scopes: string): boolean {
		if (!scopes) {
			return false;
		}
		const tokenScopes = scopes.split(', ');
		return this.AppScopes.every(x =>
			tokenScopes.indexOf(x) >= 0 ||
			tokenScopes.indexOf(this.getScopeSuperset(x)) >= 0 ||
			// some scopes don't exist on older versions of GHE, treat them as optional
			(this.isDotCom(host) || GHE_OPTIONAL_SCOPES[x])
		);
	}

	private static getScopeSuperset(scope: string): string {
		for (let key in this.GitHubScopesTable) {
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

class ResponseExpired extends Error {
	get message() { return 'Token response expired' }
}

export class GitHubServer {
	public hostConfiguration: IHostConfiguration;
	private hostUri: vscode.Uri;

	public constructor(host: string) {
		host = host.toLocaleLowerCase();
		this.hostConfiguration = { host, username: 'oauth', token: undefined };
		this.hostUri = vscode.Uri.parse(host);
	}

	public login(): Promise<IHostConfiguration> {
		const host = this.hostUri.toString()
		const uri = vscode.Uri.parse(
			`${AUTH_RELAY_SERVER}/authorize?authServer=${host}&callbackUri=${CALLBACK_URI}&scope=${SCOPES}`
		);
		vscode.commands.executeCommand('vscode.open', uri);
		return new Promise<IHostConfiguration>((resolve, reject) => {
			const subscription = uriHandler.event(async uri => {
				if (uri.path !== CALLBACK_PATH) return
				const rsp = await axios.get(`${AUTH_RELAY_SERVER}/verify?${uri.query}`)
				if (rsp.status !== 200) return
				const {ts, access_token: token} = rsp.data.token
				if (Date.now() - ts > MAX_TOKEN_RESPONSE_AGE)
					return reject(new ResponseExpired)
				resolve({host, username: 'oauth', token})
				subscription.dispose()
			})
		})
	}

	public async validate(username?: string, token?: string): Promise<IHostConfiguration> {
		if (!username) {
			username = this.hostConfiguration.username;
		}
		if (!token) {
			token = this.hostConfiguration.token;
		}

		const options = GitHubManager.getOptions(this.hostUri, 'GET', '/user', token);

		return new Promise<IHostConfiguration>((resolve, _) => {
			const get = https.request(options, res => {
				let hostConfig: IHostConfiguration | undefined;
				try {
					if (res.statusCode === 200) {
						const scopes = res.headers['x-oauth-scopes'] as string;
						if (GitHubManager.validateScopes(this.hostUri, scopes)) {
							this.hostConfiguration.username = username;
							this.hostConfiguration.token = token;
							hostConfig = this.hostConfiguration;
						}
					}
				} catch (e) {
					Logger.appendLine(`validate() error ${e}`);
				}
				resolve(hostConfig);
			});

			get.end();
			get.on('error', err => {
				resolve(undefined);
			});
		});
	}
}
