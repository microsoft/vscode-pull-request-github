import * as vscode from 'vscode';
import Logger from '../common/logger';
import { migrateToken } from './keychain';

const DEPRECATED_SETTINGS_NAMESPACES = ['github', 'githubPullRequests'];
const HOSTS_KEY = 'hosts';

export async function migrateConfiguration(migrateToKeychain = migrateToken): Promise<void> {
	for (const ns of DEPRECATED_SETTINGS_NAMESPACES) {
		await migrate(ns, migrateToKeychain);
	}
}

async function migrate(namespace: string, migrateToKeychain: typeof migrateToken) {
	const config = vscode.workspace.getConfiguration(namespace);
	if (!config) { return; }

	// With tokens stored in local storage, we don't really have per-workspace
	// authentication settings anymore. Only port global settings.
	const hosts = (config.inspect(HOSTS_KEY) || { globalValue: null }).globalValue;
	if (!Array.isArray(hosts)) { return; }
	for (const { host, token } of hosts) {
		Logger.appendLine(`Migrating ${host} from ${namespace}.${HOSTS_KEY} to keychain`);
		await migrateToKeychain(host, token);
	}
	await config.update(HOSTS_KEY, undefined, vscode.ConfigurationTarget.Global);
}
