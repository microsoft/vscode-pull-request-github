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
			socket.on('open', () => {});
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

export class WebFlow {
	hostConfiguration: IHostConfiguration;

	public constructor(host: string) {
		this.hostConfiguration = { host: host, username: 'oauth', token: undefined };
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
		let options = {
			host: HostHelper.getApiHost(this.hostConfiguration).authority,
			port: 443,
			method: 'GET',
			path: HostHelper.getApiPath(this.hostConfiguration, '/rate_limit'),
			headers: {
				'User-Agent': 'GitHub VSCode Pull Requests',
			},
		};
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
		if (!username) username = this.hostConfiguration.username;
		if (!token) token = this.hostConfiguration.token;
		let options = {
			host: HostHelper.getApiHost(this.hostConfiguration).authority,
			port: 443,
			method: 'GET',
			path: HostHelper.getApiPath(this.hostConfiguration, '/rate_limit'),
			headers: {
				'User-Agent': 'GitHub VSCode Pull Requests',
				Authorization: `token ${token}`,
			},
		};

		return new Promise<IHostConfiguration>((resolve, _) => {
			const get = https.request(options, res => {
				if (res.statusCode !== 200) {
					resolve(undefined);
				}
				let scopes = res.headers['x-oauth-scopes'] as string;
				if (!scopes) {
					resolve(undefined);
				}
				let expected = SCOPES.split(' ');
				let serverScopes = new Set(scopes.split(', '));
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
