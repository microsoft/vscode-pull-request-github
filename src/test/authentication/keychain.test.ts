import * as vscode from 'vscode';
import { Keytar, getToken, setToken, keyFor, failingKeytar, onDidChange, listHosts, migrateToken, ALL_HOSTS_KEY, deleteToken } from '../../authentication/keychain';
import assert = require('assert');
import { promiseFromEvent } from '../../common/utils';

class TestMemento implements vscode.Memento {
	map = new Map;

	get(key: any, defaultValue?: any) {
		return this.map.has(key)
			? this.map.get(key)
			: defaultValue;
	}

	async update(key: string, value: any): Promise<void> {
		this.map.set(key, value);
	}
}

class TestKeytar implements Keytar {
	map = new Map;

	async getPassword(_service: string, account: string) {
		return this.map.get(keyFor(account));
	}

	async setPassword(_service: string, account: string, password: string) {
		this.map.set(keyFor(account), password);
	}

	async deletePassword(service: string, account: string) {
		return this.map.delete(keyFor(account));
	}
}

describe('keychain', () => {
	let storage: vscode.Memento;
	beforeEach(() => storage = new TestMemento);

	let keychain: Keytar;
	beforeEach(() => keychain = new TestKeytar);

	it('getToken gets tokens set by setToken', async () => {
		await setToken('github.com', 'okta', { storage, keychain });
		await setToken('hogwarts.edu', 'levioSAH', { storage, keychain });
		assert.equal(await getToken('github.com', { storage, keychain }), 'okta');
		assert.equal(await getToken('hogwarts.edu', { storage, keychain }), 'levioSAH');
	});

	it('listHosts returns an array of all saved hosts', async () => {
		await setToken('hogwarts.edu', 'levioSAH', { storage, keychain });
		await setToken('github.com', 'okta', { storage, keychain });
		assert.deepStrictEqual((await listHosts({ storage })).sort(),
			['github.com', 'hogwarts.edu']);
	});

	describe('getToken', () => {
		it('gets tokens from the system keychain if available', async () => {
			await keychain.setPassword('', 'github.com', 'monalisa');
			assert.equal(await getToken('github.com', { storage, keychain }), 'monalisa');
		});

		it('falls back to storage if the keychain fails', async () => {
			await storage.update(keyFor('github.com'), '🐙😸');
			assert.equal(await getToken('github.com', { storage, keychain: failingKeytar }), '🐙😸');
		});
	});

	describe('setToken', () => {
		it('sets tokens into the system keychain if available', async () => {
			await setToken('github.com', '🤫', { storage, keychain });
			assert.equal(await keychain.getPassword('', 'github.com'), '🤫');
		});

		it('falls back to storage if the keychain fails', async () => {
			await setToken('github.com', '🔐', { storage, keychain: failingKeytar });
			assert.equal(await storage.get(keyFor('github.com')), '🔐');
		});

		it('fires an event when a token is set', async () => {
			const didChange = promiseFromEvent(onDidChange);
			setToken('hogwarts.edu', 'avadakedavra', { storage, keychain });
			assert.deepStrictEqual(await didChange, { host: 'hogwarts.edu', token: 'avadakedavra' });
		});
	});

	describe('deleteToken', () => {
		describe('with a system keychain', () => {
			beforeEach(async () => {
				await setToken('github.com', '🗝', { storage, keychain });
				await setToken('git.ghostbusters.com', '👻', { storage, keychain });
			});

			it('getToken no longer returns removed tokens', async () => {
				await deleteToken('github.com', { storage, keychain });
				assert.equal(await getToken('github.com', { storage, keychain }), void 0);
			});

			it('removes tokens from the keychain', async () => {
				await deleteToken('github.com', { storage, keychain });
				assert.equal(await keychain.getPassword('', 'github.com'), void 0);
			});

			it('removes hosts from the hosts list', async () => {
				await deleteToken('github.com', { storage, keychain });
				assert.deepStrictEqual(await listHosts({ storage }), ['git.ghostbusters.com']);
			});

			it('fires an event when a token is removed', async () => {
				const didChange = promiseFromEvent(onDidChange);
				deleteToken('github.com', { storage, keychain });
				assert.deepStrictEqual(await didChange, { host: 'github.com', token: undefined });
			});
		});

		describe('without a system keychain', () => {
			beforeEach(async () => {
				keychain = failingKeytar;
				await setToken('github.com', '🗝', { storage, keychain });
				await setToken('git.ghostbusters.com', '👻', { storage, keychain });
			});

			it('getToken no longer returns removed tokens', async () => {
				await deleteToken('github.com', { storage, keychain });
				assert.equal(await getToken('github.com', { storage, keychain }), void 0);
			});

			it('removes tokens from storage', async () => {
				await deleteToken('github.com', { storage, keychain });
				assert.equal(storage.get(keyFor('github.com')), void 0);
			});

			it('removes hosts from the hosts list', async () => {
				await deleteToken('github.com', { storage, keychain });
				assert.deepStrictEqual(await listHosts({ storage }), ['git.ghostbusters.com']);
			});

			it('fires an event when a token is removed', async () => {
				const didChange = promiseFromEvent(onDidChange);
				deleteToken('github.com', { storage, keychain });
				assert.deepStrictEqual(await didChange, { host: 'github.com', token: undefined });
			});
		});
	});

	describe('migrateToken', () => {
		it('when token=system, just adds a host to the list', async () => {
			await migrateToken('github.com', 'system', { storage, keychain });
			assert.deepStrictEqual(storage.get(ALL_HOSTS_KEY), {'github.com': true});
		});

		it('when token != system, sets it as per setToken', async () => {
			await migrateToken('github.com', '🦆', { storage, keychain });
			assert.equal(await getToken('github.com', { storage, keychain }), '🦆');
		});
	});
});
