import * as vscode from 'vscode';
import { IHostConfiguration, HostHelper } from './configuration';
import * as ws from 'ws';
import * as https from 'https';

const SCOPES = 'read:user user:email repo write:discussion';
const HOST = 'github-editor-auth.herokuapp.com';
const HTTP_PROTOCOL = 'https';
const WS_PROTOCOL = 'wss';

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
}

export class GitHubServer {
	public hostConfiguration: IHostConfiguration;
	private hostUri: vscode.Uri;

	public constructor(host: string) {
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
				if (res.statusCode !== 200) {
					resolve(false);
				} else {
					resolve(true);
				}
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
				if (res.statusCode !== 200) {
					resolve(undefined);
				}
				const scopes = res.headers['x-oauth-scopes'] as string;
				if (!scopes) {
					resolve(undefined);
				}
				const expected = SCOPES.split(' ');
				const serverScopes = new Set(scopes.split(', '));
				if (expected.every(x => serverScopes.has(x))) {
					this.hostConfiguration.username = username;
					this.hostConfiguration.token = token;
					resolve(this.hostConfiguration);
				}
			});

			get.end();
			get.on('error', err => {
				resolve(undefined);
			});
		});
	}
}
