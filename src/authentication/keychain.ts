import * as vscode from 'vscode';

// keytar depends on a native module shipped in vscode, so this is
// how we load it
import * as keytarType from 'keytar';

function getNodeModule<T>(moduleName: string): T | undefined {
	const vscodeRequire = eval('require');
	try {
		return vscodeRequire(`${vscode.env.appRoot}/node_modules.asar/${moduleName}`);
	} catch (err) {
		// Not in ASAR.
	}
	try {
		return vscodeRequire(`${vscode.env.appRoot}/node_modules/${moduleName}`);
	} catch (err) {
		// Not available.
	}
	return undefined;
}

export type Keytar = {
	getPassword: typeof keytarType['getPassword'];
	setPassword: typeof keytarType['setPassword'];
};

export const failingKeytar = {
	async getPassword(service, string) { throw new Error('System keychain unavailable'); },
	async setPassword(service, string, password) { throw new Error('System keychain unavailable'); },
};

const systemKeychain = getNodeModule<Keytar>('keytar') || failingKeytar;

export type GlobalStateContext = { globalState: vscode.Memento };

const SERVICE_ID = 'vscode-pull-request-github';

let defaultStorage: vscode.Memento = null;
let defaultKeychain = null;

const didChange = new vscode.EventEmitter<string>();
export const onDidChange = didChange.event;

export function init(ctx: GlobalStateContext, keychain: Keytar=systemKeychain) {
	defaultStorage = ctx.globalState;
	defaultKeychain = keychain;
}

export async function getToken(host: string, {storage=defaultStorage, keychain=defaultKeychain}={}): Promise<string> {
	host = toCanonical(host);
	return keychain.getPassword(SERVICE_ID, toCanonical(host))
		.catch(() => storage.get(keyFor(host)));
}

export async function setToken(host: string, token: string, {storage=defaultStorage, keychain=defaultKeychain, emit=true}={}) {
	host = toCanonical(host);
	await keychain.setPassword(SERVICE_ID, host, token)
		.catch(() => storage.update(keyFor(host), token));
	if (emit) { didChange.fire(host); }
}

function toCanonical(host: string): string {
	host = host.toLocaleLowerCase();
	if (host && host.endsWith('/')) {
		host = host.slice(0, -1);
	}
	return host;
}

export const keyFor = (host: string) => `keychain: ${host}`;