import * as vscode from 'vscode';

export interface IHostConfiguration {
	host: string;
	username: string | undefined;
	token: string | undefined;
}

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

	public update(username: string | undefined, token: string | undefined): void {
		if (username !== this.username || token !== this.token) {
			this.username = username;
			this.token = token;
			this._emitter.fire(this);
		}
	}
}
