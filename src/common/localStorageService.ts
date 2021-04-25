import { Memento } from 'vscode';

export class LocalStorageService {
	constructor(private storage: Memento) {}

	public getValue<T>(key: string, defaultValue: T | undefined | null = undefined): T {
		return this.storage.get<T>(key, defaultValue);
	}

	public setValue<T>(key: string, value: T) {
		this.storage.update(key, value);
	}
}
