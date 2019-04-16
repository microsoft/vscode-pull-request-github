import * as vscode from 'vscode';

// keytar depends on a native module shipped in vscode, so this is
// how we load it
import * as keytarType from 'keytar';
import { IHostConfiguration } from './configuration';

function getNodeModule<T>(moduleName: string): T | undefined {
	const vscodeRequire = eval('require');
	try {
		return vscodeRequire('keytar');
	} catch (err) {
	}
	return undefined;
}

export type Keytar = {
	getPassword: typeof keytarType['getPassword'];
	setPassword: typeof keytarType['setPassword'];
	deletePassword: typeof keytarType['deletePassword'];
};

export const failingKeytar: Keytar = {
	async getPassword(service, string) { throw new Error('System keychain unavailable'); },
	async setPassword(service, string, password) { throw new Error('System keychain unavailable'); },
	async deletePassword(service, string) { throw new Error('System keychain unavailable'); }
};

const systemKeychain = getNodeModule<Keytar>('keytar') || failingKeytar;

export type GlobalStateContext = { globalState: vscode.Memento };

const SERVICE_ID = 'vscode-pull-request-github';
export const ALL_HOSTS_KEY = 'keychain::all';

let defaultStorage: vscode.Memento | undefined = undefined;
let defaultKeychain: Keytar | undefined = undefined;

const didChange = new vscode.EventEmitter<IHostConfiguration>();
export const onDidChange = didChange.event;

export function init(ctx: GlobalStateContext, keychain: Keytar = systemKeychain) {
	defaultStorage = ctx.globalState;
	defaultKeychain = keychain;
}

export async function getToken(host: string, { storage = defaultStorage, keychain = defaultKeychain } = {}): Promise<string | null | undefined> {
	host = toCanonical(host);
	const token = keychain!.getPassword(SERVICE_ID, host)
		.catch(() => storage!.get(keyFor(host)));

	// While we're transitioning everything out of configuration and into local storage, it's possible
	// that we end up in a state where a host is not in the hosts list (perhaps because it was removed
	// from the config json file), but it is still in the keychain. In that case, we'll correctly find
	// the token and show the user as logged in, but if the user tries to log out, they won't see this
	// host. That's a pretty weird experience for the user. Thus, this next line, which ensures that
	// if we return a token for a host, that host is in the stored list of hosts.
	if (token) { await addHost(host, { storage }); }
	return token;
}

export async function setToken(host: string, token: string, { storage = defaultStorage, keychain = defaultKeychain, emit = true } = {}) {
	if (!token) { return deleteToken(host, { storage, keychain, emit }); }
	host = toCanonical(host);
	await keychain!.setPassword(SERVICE_ID, host, token)
		.catch(() => storage!.update(keyFor(host), token));
	await addHost(host, { storage });
	if (emit) { didChange.fire({ host, token }); }
}

export async function deleteToken(host: string, { storage = defaultStorage, keychain = defaultKeychain, emit = true } = {}) {
	host = toCanonical(host);
	await keychain!.deletePassword(SERVICE_ID, host)
		.catch(() => storage!.update(keyFor(host), undefined));
	const hosts = storage!.get<{ [key: string]: string }>(ALL_HOSTS_KEY, {});
	delete hosts[host];
	storage!.update(ALL_HOSTS_KEY, hosts);
	if (emit) { didChange.fire({ host, token: undefined }); }
}

export async function migrateToken(host: string, token: string, { storage = defaultStorage, keychain = defaultKeychain, emit = false } = {}) {
	host = toCanonical(host);
	if (token === 'system') {
		// Token is already in keychain, just update host list.
		return addHost(host, { storage });
	}
	return setToken(host, token, { storage, keychain, emit });
}

export async function listHosts({ storage = defaultStorage } = {}) {
	return Object.keys(storage!.get(ALL_HOSTS_KEY) || {});
}

async function addHost(host: string, { storage = defaultStorage }) {
	return storage!.update(ALL_HOSTS_KEY, { ...storage!.get(ALL_HOSTS_KEY), [host]: true });
}

const SCHEME_RE = /^[a-z-]+:\/?\/?/;
export function toCanonical(host: string): string {
	host = host.toLocaleLowerCase();
	if (host.endsWith('/')) {
		host = host.slice(0, -1);
	}
	const schemeMatch = SCHEME_RE.exec(host);
	if (schemeMatch) {
		host = host.slice(schemeMatch[0].length);
	}

	return host;
}

export const keyFor = (host: string) => `keychain: ${host}`;