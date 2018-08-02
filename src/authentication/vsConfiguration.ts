import * as vscode from 'vscode';
import { Configuration, IHostConfiguration } from './configuration';

const SETTINGS_NAMESPACE = 'github';
const HOSTS_KEY = 'hosts';

export class VSCodeConfiguration extends Configuration {
	private _hosts: Map<string, IHostConfiguration>;

	constructor() {
		super(undefined);
		this.loadConfiguration();
	}

	public listenForVSCodeChanges(): vscode.Disposable {
		return vscode.workspace.onDidChangeConfiguration(() => {
			this.loadConfiguration();
			const config = this.getHost(this.host);
			super.update(config.username, config.token, true);
		});
	}

	public setHost(host: string): IHostConfiguration {
		if (host && host.substr(host.length - 2, 1) === '/') {
			host = host.slice(0, -1);
		}

		if (this.host === host) {
			return this;
		}

		if (host === undefined) {
			this.host = host;
			this.username = undefined;
			this.token = undefined;
			return this;
		}

		this.host = host;
		this.username = undefined;
		this.token = undefined;
		if (this.host && !this._hosts.has(this.host)) {
			this._hosts.set(this.host, this);
		} else {
			const config = this.getHost(host);
			super.update(config.username, config.token);
		}
		return this;
	}

	public getHost(host: string): IHostConfiguration {
		return this._hosts.get(host);
	}

	public update(username: string | undefined, token: string | undefined, raiseEvent: boolean = true): void {
		super.update(username, token, raiseEvent);
		this.saveConfiguration();
	}

	private reset(): void {
		this._hosts = new Map<string, IHostConfiguration>();
	}

	private loadConfiguration(): void {
		this.reset();

		const config = vscode.workspace.getConfiguration(SETTINGS_NAMESPACE);
		let defaultEntry: IHostConfiguration[] = [];
		let configHosts = config.get(HOSTS_KEY, defaultEntry);

		configHosts.map(c => this._hosts.set(c.host, c));

		if (this.host && !this._hosts.has(this.host)) {
			this._hosts.set(this.host, {
				host: this.host,
				username: this.username,
				token: this.token,
			});
		}
	}

	private saveConfiguration(): void {
		if (this.host) {
			this._hosts.set(this.host, {
				host: this.host,
				username: this.username,
				token: this.token,
			});
		}
		const config = vscode.workspace.getConfiguration(SETTINGS_NAMESPACE);
		config.update(HOSTS_KEY, Array.from(this._hosts.values()), true);
	}
}
