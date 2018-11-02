import * as vscode from 'vscode';
import Logger from '../common/logger';
import { setToken } from './keychain';

const DEPRECATED_SETTINGS_NAMESPACES = ['github', 'githubPullRequests'];
const HOSTS_KEY = 'hosts';

export async function migrateConfiguration(set=setToken): Promise<void> {
	for (const ns of DEPRECATED_SETTINGS_NAMESPACES) {
		await migrate(ns, set);
	}
}

async function migrate(namespace: string, storeInKeychain: typeof setToken) {
	const config = vscode.workspace.getConfiguration(namespace);

	// With tokens stored in local storage, we don't really have per-workspace
	// authentication settings anymore. Only port global settings.
	const hosts = config.inspect(HOSTS_KEY).globalValue;
	if (!Array.isArray(hosts)) { return; }
	for (const { host, token } of hosts) {
		// Token is already stored in the system keychain
		if (token === 'system') { continue; }
		Logger.appendLine(`Migrating ${host} from ${namespace}.${HOSTS_KEY} to keychain`);
		await storeInKeychain(host, token);
	}
	await config.update(HOSTS_KEY, undefined, vscode.ConfigurationTarget.Global);
}
