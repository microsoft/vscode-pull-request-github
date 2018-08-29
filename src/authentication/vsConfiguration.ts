import * as vscode from 'vscode';
import { Configuration, IHostConfiguration } from './configuration';
import { keychain } from '../common/keychain';

const SETTINGS_NAMESPACE = 'github';
const HOSTS_KEY = 'hosts';
const CREDENTIAL_SERVICE = 'vscode-pull-request-github';

export class VSCodeConfiguration extends Configuration {
	private _hosts: Map<string, IHostConfiguration>;

	constructor() {
		super(undefined);
	}

	public listenForVSCodeChanges(): vscode.Disposable {
		return vscode.workspace.onDidChangeConfiguration(() => {
			this.loadConfiguration().then(_ => {
				if (this.host) {
					const config = this.getHost(this.host);
					super.update(config.username, config.token, true);
				}
			});
		});
	}

	public setHost(host: string): IHostConfiguration {
		host = host.toLocaleLowerCase();
		if (host && host.substr(host.length - 2, 1) === '/') {
			host = host.slice(0, -1);
		}

		if (this.host === host) {
			return this;
		}

		this.host = host;
		this.username = undefined;
		this.token = undefined;

		if (!host) {
			return this;
		}

		if (!this._hosts.has(this.host)) {
			this._hosts.set(this.host, this);
		} else {
			const config = this.getHost(host);
			super.update(config.username, config.token);
		}
		return this;
	}

	public getHost(host: string): IHostConfiguration {
		return this._hosts.get(host.toLocaleLowerCase());
	}

	public removeHost(host: string): void {
		this._hosts.delete(host);
		if (host === this.host) {
			super.update(undefined, undefined, false);
		}
		this.saveConfiguration();
	}

	public async update(username: string | undefined, token: string | undefined, raiseEvent: boolean = true): Promise<void> {
		super.update(username, token, raiseEvent);
		await keychain.setPassword(CREDENTIAL_SERVICE, this.host, token);
		this.saveConfiguration();
	}

	private reset(): void {
		this._hosts = new Map<string, IHostConfiguration>();
	}

	public async loadConfiguration(): Promise<void> {
		this.reset();

		const config = vscode.workspace.getConfiguration(SETTINGS_NAMESPACE);
		let defaultEntry: IHostConfiguration[] = [];
		let configHosts = config.get(HOSTS_KEY, defaultEntry);

		configHosts.forEach(c => c.host = c.host.toLocaleLowerCase());
		return Promise.all(configHosts.map(async c => {
			// if the token is not in the user settings file, load it from the system credential manager
			if (c.token === 'system') {
				c.token = await keychain.getPassword(CREDENTIAL_SERVICE, c.host) || undefined;
			} else {
				// the token might have been filled out in the settings file, load it from there if so
				await keychain.setPassword(CREDENTIAL_SERVICE, c.host, c.token);
			}
			this._hosts.set(c.host, c);
		})).then(_ => {
			if (this.host && !this._hosts.has(this.host)) {
				this._hosts.set(this.host, {
					host: this.host,
					username: this.username,
					token: this.token,
				});
			}
		});
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
		// don't save the token to the user settings file
		config.update(HOSTS_KEY, Array.from(this._hosts.values()).map(x => { return { host: x.host, username: x.username, token: 'system' }; }), true);
	}
}
