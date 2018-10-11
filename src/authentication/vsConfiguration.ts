import * as vscode from 'vscode';
import { Configuration, IHostConfiguration } from './configuration';
import { keychain } from '../common/keychain';
import Logger from '../common/logger';

const SETTINGS_NAMESPACE = 'githubPullRequests';
const DEPRECATED_SETTINGS_NAMESPACE = 'github';
const HOSTS_KEY = 'hosts';
const CREDENTIAL_SERVICE = 'vscode-pull-request-github';

export class VSCodeConfiguration extends Configuration {
	private _hosts: Map<string, IHostConfiguration> = new Map<string, IHostConfiguration>();
	private _hostTokensInKeychain: Set<string> = new Set<string>();

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
		if (host && host.endsWith('/')) {
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

	public async update(username: string | undefined, token: string | undefined, raiseEvent: boolean = true): Promise<boolean> {
		const key = this.host;
		try {
			// this might fail. if it does, fallback to saving the token in the user settings file
			await keychain.setPassword(CREDENTIAL_SERVICE, key, token);
			if (!this._hostTokensInKeychain.has(key)) {
				this._hostTokensInKeychain.add(key);
			}
		} catch (e) {
			if (this._hostTokensInKeychain.has(key)) {
				this._hostTokensInKeychain.delete(key);
			}
		}
		return super.update(username, token, false).then(hasChanged => {
			if (hasChanged) {
				this.saveConfiguration();
				// raise changed events only after the host list has been roundtripped to disk
				if (raiseEvent) {
					this.raiseChangedEvent();
				}
			}
			return hasChanged;
		});
	}

	private reset(): void {
		this._hosts.clear();
		this._hostTokensInKeychain.clear();
	}

	private async migrateConfiguration(): Promise<void> {
		const config = vscode.workspace.getConfiguration(SETTINGS_NAMESPACE);
		const deprecated = vscode.workspace.getConfiguration(DEPRECATED_SETTINGS_NAMESPACE);
		const { globalValue, workspaceFolderValue, workspaceValue } = deprecated.inspect(HOSTS_KEY);
		const values = [
			{ target: vscode.ConfigurationTarget.Global, value: globalValue },
			{ target: vscode.ConfigurationTarget.WorkspaceFolder, value: workspaceFolderValue },
			{ target: vscode.ConfigurationTarget.Workspace, value: workspaceValue },
		].filter(({ value }) => value !== undefined);

		if (values.length > 0) {
			Logger.appendLine(`Migrating deprecated '${DEPRECATED_SETTINGS_NAMESPACE}.${HOSTS_KEY}' setting.`);

			for (const { target, value } of values) {
				await config.update(HOSTS_KEY, value, target);
				await deprecated.update(HOSTS_KEY, undefined, target);
			}
		}
	}

	public async loadConfiguration(): Promise<void> {
		this.reset();

		await this.migrateConfiguration();

		const config = vscode.workspace.getConfiguration(SETTINGS_NAMESPACE);
		let defaultEntry: IHostConfiguration[] = [];
		let configHosts = config.get(HOSTS_KEY, defaultEntry);

		configHosts.forEach(c => {
			if (!c.host) {
				c.host = '';
			}
			c.host = c.host.toLocaleLowerCase();
			if (c.host.endsWith('/')) {
				c.host = c.host.slice(0, -1);
			}
		});
		return Promise.all(configHosts.map(async c => {
			// if the token is not in the user settings file, load it from the system credential manager
			if (c.token === 'system') {
				try {
					c.token = await keychain.getPassword(CREDENTIAL_SERVICE, c.host) || undefined;
					if (c.token) {
						this._hostTokensInKeychain.add(c.host);
					}
				} catch { }
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
		// don't save the token to the user settings file if it's in the keychain
		config.update(HOSTS_KEY, Array.from(this._hosts.values()).map(x => {
			const token = this._hostTokensInKeychain.has(x.host) ? 'system' : x.token;
			return { host: x.host, username: x.username, token };
		}), true);
	}
}
