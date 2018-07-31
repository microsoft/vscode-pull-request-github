import * as vscode from 'vscode';
import { IHostConfiguration } from './configuration';
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

export interface IWebFlow {
	authenticated: boolean;
	host: IHostConfiguration;
}

export class WebFlow implements IWebFlow {
	authenticated: boolean;
	host: IHostConfiguration;

	public constructor(host: string) {
		this.host = { host: host, username: 'oauth', token: undefined };
	}

	public async login(): Promise<IWebFlow> {
		return new Promise<IWebFlow>((resolve, reject) => {
			new Client(this.host.host, SCOPES)
				.start()
				.then(token => {
					this.host.token = token;
					resolve(this);
				})
				.catch(reject);
		});
	}

	public async validate(creds: IHostConfiguration): Promise<boolean> {
		let options = {
			host: `api.${creds.host}`,
			port: 443,
			method: 'GET',
			path: '/rate_limit',
			headers: {
				'User-Agent': 'GitHub VSCode Pull Requests',
				Authorization: `token ${creds.token}`,
			},
		};
		return new Promise<boolean>((resolve, _) => {
			const get = https.request(options, res => {
				if (res.statusCode !== 200) {
					resolve(false);
				}
				let scopes = res.headers['x-oauth-scopes'] as string;
				if (!scopes) {
					resolve(false);
				}
				let expected = SCOPES.split(' ');
				let serverScopes = new Set(scopes.split(', '));
				resolve(expected.every(x => serverScopes.has(x)));
			});

			get.end();
			get.on('error', err => {
				resolve(false);
			});
		});
	}
}
