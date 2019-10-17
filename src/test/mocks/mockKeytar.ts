import { Keytar } from '../../authentication/keychain';

export class MockKeytar implements Keytar {
	private _storage: { [serviceName: string]: { [accountName: string]: string } } = {};

	getPassword(service: string, account: string): Promise<string | null> {
		const accountMap = this._storage[service] || {};
		return Promise.resolve(accountMap[account] || null);
	}

	setPassword(service: string, account: string, password: string): Promise<void> {
		const accountMap = this._storage[service];
		if (accountMap) {
			accountMap[account] = password;
		} else {
			this._storage[service] = {[account]: password};
		}
		return Promise.resolve();
	}

	deletePassword(service: string, account: string): Promise<boolean> {
		const accountMap = this._storage[service];
		if (accountMap) {
			const had = account in accountMap;
			delete accountMap[account];
			return Promise.resolve(had);
		} else {
			return Promise.resolve(false);
		}
	}
}