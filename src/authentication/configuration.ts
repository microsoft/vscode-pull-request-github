import * as vscode from 'vscode';

export interface IAppConfiguration {
    clientId: string | undefined;
    clientSecret: string | undefined;
}

export class AppConfiguration implements IAppConfiguration {
    constructor(public clientId: string | undefined, public clientSecret: string | undefined) {}
}

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
    private emitter: vscode.EventEmitter<IConfiguration>;

    constructor(public host: string) {
        this.emitter = new vscode.EventEmitter<IConfiguration>();
        this.onDidChange = this.emitter.event;
    }

    update(username: string | undefined, token: string | undefined) {
        if (username !== this.username || token !== this.token) {
            this.username = username;
            this.token = token;
            this.emitter.fire(this);
        }
    }
}
