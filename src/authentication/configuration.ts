import * as vscode from 'vscode';

export interface IHostConfiguration {
	host: string;
	username: string | undefined;
	token: string | undefined;
}

export const HostHelper = class {
	public static getApiHost(host: IHostConfiguration): vscode.Uri {
		const hostUri = vscode.Uri.parse(host.host);
		if (hostUri.authority === 'github.com') {
			return vscode.Uri.parse('https://api.github.com');
		} else {
			return vscode.Uri.parse(`${hostUri.scheme}://${hostUri.authority}`);
		}
	}

	public static getApiPath(host: IHostConfiguration, path: string): string {
		const hostUri = vscode.Uri.parse(host.host);
		if (hostUri.authority === 'github.com') {
			return path;
		} else {
			return `/api/v3${path}`;
		}
	}
};

export interface IConfiguration extends IHostConfiguration {
	onDidChange: vscode.Event<IConfiguration>;
}

export class Configuration implements IConfiguration {
	username: string | undefined;
	token: string | undefined;
	onDidChange: vscode.Event<IConfiguration>;
	private _emitter: vscode.EventEmitter<IConfiguration>;

	constructor(public host: string) {
		this._emitter = new vscode.EventEmitter<IConfiguration>();
		this.onDidChange = this._emitter.event;
	}

	public update(username: string | undefined, token: string | undefined, raiseEvent: boolean = true): void {
		if (username !== this.username || token !== this.token) {
			this.username = username;
			this.token = token;
			if (raiseEvent) {
				this._emitter.fire(this);
			}
		}
	}
}
