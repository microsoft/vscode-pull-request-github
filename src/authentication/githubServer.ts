import * as vscode from 'vscode';
import { IHostConfiguration, HostHelper } from './configuration';
import * as ws from 'ws';
import * as https from 'https';
import Logger from '../common/logger';

const SCOPES: string = 'read:user user:email repo write:discussion';
const HOST: string = 'github-editor-auth.herokuapp.com';
const HTTP_PROTOCOL: string = 'https';
const WS_PROTOCOL: string = 'wss';

enum MessageType {
	Host = 0x2,
	Token = 0x8,
}

interface IMessage {
	type: MessageType;
	guid: string;
	host?: string;
	token?: string;
	scopes?: string;
}

class Client {
	private _guid?: string;

	constructor(private host: string, private scopes: string) {}

	public start(): Promise<string> {
		return new Promise((resolve, reject) => {
			const socket = new ws(`${WS_PROTOCOL}://${HOST}`);
			socket.on('message', data => {
				const message: IMessage = JSON.parse(data.toString());

				switch (message.type) {
					case MessageType.Host:
						{
							this._guid = message.guid;

							socket.send(
								JSON.stringify({
									type: MessageType.Host,
									guid: this._guid,
									host: this.host,
									scopes: this.scopes,
								})
							);
							vscode.commands.executeCommand(
								'vscode.open',
								vscode.Uri.parse(`${HTTP_PROTOCOL}://${HOST}?state=action:login;guid:${this._guid}`)
							);
						}
						break;
					case MessageType.Token:
						{
							socket.close();
							resolve(message.token);
						}
						break;
					default: {
						socket.close();
					}
				}
				socket.on('close', (code, reason) => {
					if (code !== 1000) {
						reject(reason);
					}
				});
			});
		});
	}
}

export class GitHubManager {
	private servers: Map<string, boolean>;

	private static GitHubScopesTable: { [key: string] : string[] } = {
		'repo': ['repo:status', 'repo_deployment', 'public_repo', 'repo:invite'],
		'admin:org': ['write:org', 'read:org'],
		'admin:public_key': ['write:public_key', 'read:public_key'],
		'admin:org_hook': [],
		'gist': [],
		'notifications': [],
		'user': ['read:user', 'user:email', 'user:follow'],
		'delete_repo': [],
		'write:discussion': ['read:discussion'],
		'admin:gpg_key': ['write:gpg_key', 'read:gpg_key']
	};

	public static AppScopes: string[] = SCOPES.split(' ');

	constructor() {
		this.servers = new Map().set('github.com', true);
	}

	public async isGitHub(host: vscode.Uri): Promise<boolean> {
		if (this.servers.has(host.authority)) {
			return this.servers.get(host.authority);
		}

		const options = GitHubManager.getOptions(host, 'HEAD');
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
			this.servers.set(host.authority, isGitHub);
			return isGitHub;
		});
	}

	public static getOptions(hostUri: vscode.Uri, method: string = 'GET', token?: string) {
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
			path: HostHelper.getApiPath(hostUri, '/rate_limit'),
			headers,
		};
	}

	public static validateScopes(scopes: string): boolean {
		if (!scopes) {
			return false;
		}
		const tokenScopes = scopes.split(', ');
		return (this.AppScopes.every(x => tokenScopes.indexOf(x) >= 0 || tokenScopes.indexOf(this.getScopeSuperset(x)) >= 0))
	}

	private static getScopeSuperset(scope: string): string
	{
		for (let key in this.GitHubScopesTable) {
			if (this.GitHubScopesTable[key].indexOf(scope) >= 0)
				return key;
		}
		return scope;
	}

}

export class GitHubServer {
	public hostConfiguration: IHostConfiguration;
	private hostUri: vscode.Uri;

	public constructor(host: string) {
		host = host.toLocaleLowerCase();
		this.hostConfiguration = { host, username: 'oauth', token: undefined };
		this.hostUri = vscode.Uri.parse(host);
	}

	public async login(): Promise<IHostConfiguration> {
		return new Promise<IHostConfiguration>((resolve, reject) => {
			new Client(this.hostConfiguration.host, SCOPES)
				.start()
				.then(token => {
					this.hostConfiguration.token = token;
					resolve(this.hostConfiguration);
				})
				.catch(reason => {
					resolve(undefined);
				});
		});
	}

	public async checkAnonymousAccess(): Promise<boolean> {
		const options = GitHubManager.getOptions(this.hostUri);
		return new Promise<boolean>((resolve, _) => {
			const get = https.request(options, res => {
				resolve(res.statusCode === 200);
			});

			get.end();
			get.on('error', err => {
				resolve(false);
			});
		});
	}

	public async validate(username?: string, token?: string): Promise<IHostConfiguration> {
		if (!username) {
			username = this.hostConfiguration.username;
		}
		if (!token) {
			token = this.hostConfiguration.token;
		}

		const options = GitHubManager.getOptions(this.hostUri, 'GET', token);

		return new Promise<IHostConfiguration>((resolve, _) => {
			const get = https.request(options, res => {
				let hostConfig: IHostConfiguration | undefined;
				try {
					if (res.statusCode === 200) {
						const scopes = res.headers['x-oauth-scopes'] as string;
						if (GitHubManager.validateScopes(scopes)) {
							this.hostConfiguration.username = username;
							this.hostConfiguration.token = token;
							hostConfig = this.hostConfiguration;
						}
					}
				} catch(e) {
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
