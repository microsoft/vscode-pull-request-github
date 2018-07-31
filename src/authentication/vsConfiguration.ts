import * as vscode from 'vscode';
import { AppConfiguration, Configuration, IHostConfiguration } from './configuration';

const SETTINGS_NAMESPACE = 'github';
const CLIENT_ID_KEY = 'clientId';
const CLIENT_SECRET_KEY = 'clientSecret';
const HOSTS_KEY = 'hosts';

export class VSCodeAppConfiguration extends AppConfiguration {
	constructor() {
		const config = vscode.workspace.getConfiguration(SETTINGS_NAMESPACE);
		// if clientID or clientSecret aren't passed in, look for them in the settings and the environment
		const clientId: string | undefined = config.has(CLIENT_ID_KEY)
			? config.get(CLIENT_ID_KEY)
			: process.env.GITHUB_VSCODE_CLIENT_ID;

		const clientSecret: string | undefined = config.has(CLIENT_SECRET_KEY)
			? config.get(CLIENT_SECRET_KEY)
			: process.env.GITHUB_VSCODE_CLIENT_SECRET;
		super(clientId, clientSecret);
	}
}

export class VSCodeConfiguration extends Configuration {
	private hosts: { [key: string]: any };

	constructor(public host: string) {
		super(host);
		this.hosts = [];
		this.loadHosts();
		const config = this.getHost(this.host);
		super.update(config.username, config.token);
	}

	listenForVSCodeChanges() {
		return vscode.workspace.onDidChangeConfiguration(() => {
			this.loadHosts();
			const conf = this.getHost(this.host);
			super.update(conf.username, conf.token);
		});
	}

	update(username: string | undefined, token: string | undefined) {
		super.update(username, token);
		this.saveConfiguration();
	}

	getHost(host: string): IHostConfiguration {
		if (this.hosts[host] === undefined) {
			return;
		}
		let idx: number = this.hosts[host];
		return this.hosts[idx];
	}

	private reset() {
		this.hosts = [];
	}

	private loadHosts() {
		this.reset();

		const config = vscode.workspace.getConfiguration(SETTINGS_NAMESPACE);
		let defaultEntry: IHostConfiguration[] = [];
		let configHosts = config.get(HOSTS_KEY, defaultEntry);

		configHosts.map(c => this.setHost(c));

		if (this.hosts[this.host] === undefined) {
			this.setHost({
				host: this.host,
				username: undefined,
				token: undefined
			});
		}
	}

	private saveConfiguration() {
		this.setHost({
			host: this.host,
			username: this.username,
			token: this.token
		});
		const config = vscode.workspace.getConfiguration(SETTINGS_NAMESPACE);
		config.update(HOSTS_KEY, this.hosts as [], true);
	}

	private setHost(host: IHostConfiguration) {
		if (this.hosts[host.host] === undefined) {
			this.hosts.push(host);
			this.hosts[host.host] = this.hosts.length - 1;
		} else {
			let idx: number = this.hosts[host.host];
			this.hosts[idx] = host;
		}
	}
}
