import { Memento } from 'vscode';

export class InMemoryMemento implements Memento {
	private _storage: { [keyName: string]: any } = {};

	get<T>(key: string): T | undefined; get<T>(key: string, defaultValue: T): T;
	get(key: string, defaultValue?: any) {
		return this._storage[key] || defaultValue;
	}

	update(key: string, value: any): Thenable<void> {
		this._storage[key] = value;
		return Promise.resolve();
	}

	setKeysForSync(keys: string[]): void { }
}