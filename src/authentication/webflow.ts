import * as vscode from 'vscode';
import { IHostConfiguration, IAppConfiguration } from './configuration';
import * as url from 'url';
import * as qs from 'querystring';
import * as uuid from 'uuid/v4';
import * as express from 'express';
import * as http from 'http';
import * as https from 'https';
import { Request, Response } from '../../node_modules/@types/express-serve-static-core';

const OAUTH_STEP1 = '/login/oauth/authorize';
const OAUTH_STEP2 = '/login/oauth/access_token';
const SCOPES = 'read:user user:email repo write:discussion';
const SERVER_PORT = 55555;
const SERVER_URI = `http://localhost:${SERVER_PORT}`;
const PATH_CONNECT = '/connect';
const PATH_CANCEL = '/cancel';
const PATH_AUTHENTICATE = '/authenticate';

export interface IWebFlow {
	authenticated: boolean;
	host: IHostConfiguration | undefined;
}

export class WebFlow implements IWebFlow {
	authenticated: boolean;
	host: IHostConfiguration | undefined;
	private loginPromise: Promise<IWebFlow> | undefined;

	private oauthStep1: url.URL;
	private oauthStep2: url.URL;
	private state: string;
	private app: IAppConfiguration;
	private listener: http.Server | undefined;
	private failed: boolean;

	public constructor(app: IAppConfiguration, host: string) {
		this.loginPromise = undefined;
		this.authenticated = false;
		this.failed = false;
		this.state = uuid().toString();
		this.host = { host: host, username: 'oauth', token: undefined };
		this.app = app;
		this.oauthStep1 = new url.URL(OAUTH_STEP1, 'https://' + this.host.host);
		this.oauthStep1.search = qs.stringify(this.buildStep1Request());
		this.oauthStep2 = new url.URL(OAUTH_STEP2, 'https://' + this.host.host);
	}

	public async login() {
		const server = express();
		this.loginPromise = new Promise((resolve, reject) => {
			server.get(PATH_CONNECT, this.serveConnectionPage());
			server.get(PATH_AUTHENTICATE, this.doAuthentication(resolve, reject));
			server.get(PATH_CANCEL, this.serveCancelPage(reject));
			this.listener = http.createServer(server);
			this.listener.listen(SERVER_PORT);
			vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(`${SERVER_URI}${PATH_CONNECT}`));
		});
		this.loginPromise.catch(err => {
			this.stop();
			throw err;
		});
		return this.loginPromise;
	}

	public async validate(creds: IHostConfiguration) {
		let options = {
			host: `api.${creds.host}`,
			port: 443,
			method: 'GET',
			path: '/rate_limit',
			headers: {
				'User-Agent': 'VSCode Pull Requests',
				Authorization: `token ${creds.token}`
			}
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
				var ret = expected.filter(x => {
					return serverScopes.has(x);
				});
				resolve(ret.length === expected.length);
			});

			get.end();
			get.on('error', err => {
				resolve(false);
			});
		});
	}

	private stop(): void {
		if (!this.listener) {
			return;
		}
		this.listener.close();
		this.listener = undefined;
	}

	private serveConnectionPage(): any {
		const _this = this;
		return (req: Request, res: Response) => {
			let url = _this.oauthStep1.toString();
			res.send(`<h1>Authorizing Visual Studio Code to access GitHub.</h1>
            <p>If you initiated this authorization from Visual Studio Code, click continue to authorize access to GitHub.</p>
            <input class='button success' type='button' value='Continue authorization' onclick="window.location.href='${url}'" />
            <input class='button danger' type='button' value='Do not authorize' onclick="window.location.href='${SERVER_URI}${PATH_CANCEL}'" />`);
		};
	}

	private serveSuccessPage(res: Response): any {
		res.send('<p>Login successful, you can go back to Visual Studio Code</p>');
		res.end();
	}

	private serveFailedPage(reason, res: Response): any {
		res.send(`<p>Login failed: ${reason}</p>`);
		res.end();
	}

	private serveCancelPage(reject: (reason?: any) => void): any {
		const _this = this;
		return (req: Request, res: Response) => {
			res.send('<p>Login cancelled</p>');
			reject(new Error('User cancelled'));
			_this.stop();
		};
	}

	private doAuthentication(
		resolve: (value?: IWebFlow | PromiseLike<IWebFlow> | undefined) => void,
		reject: (reason?: any) => void
	): any {
		const _this = this;
		return (req: Request, res: Response) => {
			const reqState = req.param('state');
			const reqCode = req.param('code');
			if (!_this.verifyState(reqState)) {
				let reason = 'Invalid state';
				this.serveFailedPage(reason, res);
				reject(new Error(reason));
				return;
			}

			const step2Data = _this.buildStep2Request(reqCode);

			const post = https.request(step2Data.headers, postResponse => {
				if (postResponse.statusCode !== 200) {
					let reason = `Error ${postResponse.statusCode}`;
					this.serveFailedPage(reason, res);
					reject(new Error(reason));
					return;
				}

				let body = '';
				postResponse.on('data', chunk => {
					body += chunk;
				});

				postResponse.on('end', () => {
					if (_this.failed) {
						return;
					}
					const json = JSON.parse(body);
					_this.host.token = json['access_token'] as string;
					_this.authenticated = true;
					this.serveSuccessPage(res);
					resolve(_this);
				});

				postResponse.on('error', err => {
					_this.failed = true;
					let reason = `Error ${err}`;
					this.serveFailedPage(reason, res);
					reject(err);
				});
			});

			post.on('error', err => {
				_this.failed = true;
				let reason = `Error ${err}`;
				this.serveFailedPage(reason, res);
				reject(err);
			});

			post.write(qs.stringify(step2Data.data));
			post.end();
		};
	}

	private verifyState(state: string): boolean {
		return this.state === state;
	}

	private buildStep1Request(): object {
		return {
			client_id: this.app.clientId,
			scope: SCOPES,
			state: this.state,
			redirect_uri: `${SERVER_URI}${PATH_AUTHENTICATE}`
		};
	}

	private buildStep2Request(code: string): { headers: object; data: object } {
		const args = {
			client_id: this.app.clientId,
			client_secret: this.app.clientSecret,
			code: code,
			state: this.state,
			redirect_uri: `${SERVER_URI}/done`
		};
		return {
			headers: {
				hostname: this.oauthStep2.hostname,
				port: 443,
				method: 'POST',
				path: this.oauthStep2.toString(),
				headers: {
					'User-Agent': 'VSCode Pull Requests',
					Accept: 'application/json',
					'Content-Type': 'application/x-www-form-urlencoded',
					'Content-Length': Buffer.byteLength(qs.stringify(args))
				}
			},
			data: args
		};
	}
}
