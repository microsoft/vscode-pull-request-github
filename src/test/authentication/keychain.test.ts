import * as vscode from 'vscode';
import { Keytar, getToken, setToken, keyFor, failingKeytar } from '../../authentication/keychain';
import * as assert from 'assert';

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
}

describe('keychain', () => {
	let storage: vscode.Memento;
	beforeEach(() => storage = new TestMemento);

	let keychain: Keytar;
	beforeEach(() => keychain = new TestKeytar);

	it('getToken gets tokens set by setToken', async () => {
		await setToken('github.com', 'okta', {storage, keychain});
		await setToken('hogwarts.edu', 'levioSAH', {storage, keychain});
		assert.equal(await getToken('github.com', {storage, keychain}), 'okta');
		assert.equal(await getToken('hogwarts.edu', {storage, keychain}), 'levioSAH');
	});

	describe('getToken', () => {
		it('gets tokens from the system keychain if available', async () => {
			await keychain.setPassword(null, 'github.com', 'monalisa');
			assert.equal(await getToken('github.com', {storage, keychain}), 'monalisa');
		});

		it('falls back to storage if the keychain fails', async () => {
			await storage.update(keyFor('github.com'), '🐙😸');
			assert.equal(await getToken('github.com', {storage, keychain: failingKeytar}), '🐙😸');
		});
	});

	describe('setToken', () => {
		it('sets tokens into the system keychain if available', async () => {
			await setToken('github.com', '🤫', {storage, keychain});
			assert.equal(await keychain.getPassword(null, 'github.com'), '🤫');
		});

		it('falls back to storage if the keychain fails', async () => {
			await setToken('github.com', '🔐', {storage, keychain: failingKeytar});
			assert.equal(await storage.get(keyFor('github.com')), '🔐');
		});
	});
});