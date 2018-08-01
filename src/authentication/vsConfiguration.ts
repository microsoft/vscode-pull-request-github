import * as vscode from 'vscode';
import { Configuration, IHostConfiguration } from './configuration';

const SETTINGS_NAMESPACE = 'github';
const HOSTS_KEY = 'hosts';

export class VSCodeConfiguration extends Configuration {
	private _hosts: Map<string, IHostConfiguration>;

	constructor(public host: string) {
		super(host);
		this.loadHosts();
		const config = this.getHost(this.host);
		super.update(config.username, config.token);
	}

	public listenForVSCodeChanges(): vscode.Disposable {
		return vscode.workspace.onDidChangeConfiguration(() => {
			this.loadHosts();
			const config = this.getHost(this.host);
			super.update(config.username, config.token, true);
		});
	}

	public update(username: string | undefined, token: string | undefined, raiseEvent: boolean = true): void {
		super.update(username, token, raiseEvent);
		this.saveConfiguration();
	}

	public getHost(host: string): IHostConfiguration {
		return this._hosts.get(host);
	}

	private reset(): void {
		this._hosts = new Map<string, IHostConfiguration>();
	}

	private loadHosts(): void {
		this.reset();

		const config = vscode.workspace.getConfiguration(SETTINGS_NAMESPACE);
		let defaultEntry: IHostConfiguration[] = [];
		let configHosts = config.get(HOSTS_KEY, defaultEntry);

		configHosts.map(c => this.setHost(c));

		if (!this._hosts.has(this.host)) {
			this.setHost({
				host: this.host,
				username: undefined,
				token: undefined,
			});
		}
	}

	private saveConfiguration(): void {
		this.setHost({
			host: this.host,
			username: this.username,
			token: this.token,
		});
		const config = vscode.workspace.getConfiguration(SETTINGS_NAMESPACE);
		config.update(HOSTS_KEY, Array.from(this._hosts.values()), true);
	}

	private setHost(host: IHostConfiguration): void {
		this._hosts.set(host.host, host);
	}
}
