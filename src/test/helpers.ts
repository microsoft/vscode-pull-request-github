import * as path from 'path';
import * as temp from 'temp';
import { ExtensionContext, Memento, Uri } from 'vscode';

import { ITelemetry } from '../github/interface';
import { Repository, RepositoryState, RepositoryUIState, Commit, Branch } from '../api/api';
import { Keytar } from '../authentication/keychain';

export class InMemoryMemento implements Memento {
	private _storage: {[keyName: string]: any} = {};

	get<T>(key: string): T | undefined;	get<T>(key: string, defaultValue: T): T;
	get(key: string, defaultValue?: any) {
		return this._storage[key] || defaultValue;
	}

	update(key: string, value: any): Thenable<void> {
		this._storage[key] = value;
		return Promise.resolve();
	}
}

export class MockKeytar implements Keytar {
	private _storage: { [serviceName: string]: { [accountName: string]: string } } = {};

	getPassword(service: string, account: string): Promise<string | null> {
		const accountMap = this._storage[service] || {};
		return Promise.resolve(accountMap[account] || null);
	}

	setPassword(service: string, account: string, password: string): Promise<void> {
		let accountMap = this._storage[service];
		if (accountMap) {
			accountMap[account] = password;
		} else {
			this._storage[service] = {[account]: password};
		}
		return Promise.resolve();
	}

	deletePassword(service: string, account: string): Promise<boolean> {
		let accountMap = this._storage[service];
		if (accountMap) {
			const had = account in accountMap;
			delete accountMap[account];
			return Promise.resolve(had);
		} else {
			return Promise.resolve(false);
		}
	}
}

export class MockExtensionContext implements ExtensionContext {
	extensionPath = path.resolve(__dirname, '..');

	workspaceState = new InMemoryMemento();
	globalState = new InMemoryMemento();
	subscriptions: { dispose(): any; }[] = [];

	storagePath: string;
	globalStoragePath: string;
	logPath: string;

	constructor() {
		this.storagePath = temp.mkdirSync('storage-path');
		this.globalStoragePath = temp.mkdirSync('global-storage-path');
		this.logPath = temp.mkdirSync('log-path');
	}

	asAbsolutePath(relativePath: string): string {
		return path.resolve(this.extensionPath, relativePath);
	}

	dispose() {
		this.subscriptions.forEach(sub => sub.dispose());
	}
}

export class MockRepository implements Repository {
	rootUri = Uri.file('/root');

	state: RepositoryState = {
		HEAD: undefined,
		refs: [],
		remotes: [],
		submodules: [],
		rebaseCommit: undefined,
		mergeChanges: [],
		indexChanges: [],
		workingTreeChanges: [],
		onDidChange: () => ({ dispose() {} }),
	};

	ui: RepositoryUIState = {
		selected: true,
		onDidChange: () => ({ dispose() {} }),
	};

	getConfigs(): Promise<{ key: string; value: string; }[]> {
		return Promise.reject(new Error('Unexpected getConfigs()'));
	}
	getConfig(key: string): Promise<string> {
		return Promise.reject(new Error(`Unexpected getConfig(${key})`));
	}
	setConfig(key: string, value: string): Promise<string> {
		return Promise.reject(new Error(`Unexpected setConfig(${key}, ${value})`));
	}
	getObjectDetails(treeish: string, treePath: string): Promise<{ mode: string; object: string; size: number; }> {
		return Promise.reject(new Error(`Unexpected getObjectDetails(${treeish}, ${treePath})`));
	}
	show(ref: string, treePath: string): Promise<string> {
		return Promise.reject(new Error(`Unexpected show(${ref}, ${treePath})`));
	}
	getCommit(ref: string): Promise<Commit> {
		return Promise.reject(new Error(`Unexpected getCommit(${ref})`));
	}
	apply(patch: string, reverse?: boolean | undefined): Promise<void> {
		return Promise.reject(new Error(`Unexpected apply(..., ${reverse})`));
	}
	diff(cached?: boolean | undefined): Promise<string> {
		return Promise.reject(new Error(`Unexpected diff(${cached})`));
	}
	diffWith(ref: string, treePath: string): Promise<string> {
		return Promise.reject(new Error(`Unexpected diffWith(${ref}, ${treePath})`));
	}
	diffBlobs(object1: string, object2: string): Promise<string> {
		return Promise.reject(new Error(`Unexpected diffBlobs(${object1}, ${object2})`));
	}
	diffBetween(ref1: string, ref2: string, treePath: string): Promise<string> {
		return Promise.reject(new Error(`Unexpected diffBlobs(${ref1}, ${ref2}, ${treePath})`));
	}
	hashObject(data: string): Promise<string> {
		return Promise.reject(new Error('Unexpected hashObject(...)'));
	}
	createBranch(name: string, checkout: boolean, ref?: string | undefined): Promise<void> {
		return Promise.reject(new Error(`Unexpected createBranch(${name}, ${checkout}, ${ref})`));
	}
	deleteBranch(name: string, force?: boolean | undefined): Promise<void> {
		return Promise.reject(new Error(`Unexpected deleteBranch(${name}, ${force})`));
	}
	getBranch(name: string): Promise<Branch> {
		return Promise.reject(new Error(`Unexpected getBranch(${name})`));
	}
	setBranchUpstream(name: string, upstream: string): Promise<void> {
		return Promise.reject(new Error(`Unexpected setBranchUpstream(${name})`));
	}
	status(): Promise<void> {
		return Promise.reject(new Error('Unexpected status()'));
	}
	checkout(treeish: string): Promise<void> {
		return Promise.reject(new Error(`Unexpected checkout(${treeish})`));
	}
	addRemote(name: string, url: string): Promise<void> {
		return Promise.reject(new Error(`Unexpected addRemote(${name}, ${url})`));
	}
	removeRemote(name: string): Promise<void> {
		return Promise.reject(new Error(`Unexpected removeRemote(${name})`));
	}
	fetch(remote?: string | undefined, ref?: string | undefined, depth?: number | undefined): Promise<void> {
		return Promise.reject(new Error(`Unexpected fetch(${remote}, ${ref}, ${depth})`));
	}
	pull(unshallow?: boolean | undefined): Promise<void> {
		return Promise.reject(new Error(`Unexpected pull(${unshallow})`));
	}
	push(remoteName?: string | undefined, branchName?: string | undefined, setUpstream?: boolean | undefined): Promise<void> {
		return Promise.reject(new Error(`Unexpected push(${remoteName}, ${branchName}, ${setUpstream})`));
	}
	blame(treePath: string): Promise<string> {
		return Promise.reject(new Error(`Unexpected blame(${treePath})`));
	}
}

export class MockTelemetry implements ITelemetry {
	private events: string[] = [];
	private alive = true;

	on(action: 'startup'): Promise<void>;
	on(action: 'authSuccess'): Promise<void>;
	on(action: 'commentsFromEditor'): Promise<void>;
	on(action: 'commentsFromDescription'): Promise<void>;
	on(action: 'prListExpandLocalPullRequest'): Promise<void>;
	on(action: 'prListExpandRequestReview'): Promise<void>;
	on(action: 'prListExpandAssignedToMe'): Promise<void>;
	on(action: 'prListExpandMine'): Promise<void>;
	on(action: 'prListExpandAll'): Promise<void>;
	on(action: 'prCheckoutFromContext'): Promise<void>;
	on(action: 'prCheckoutFromDescription'): Promise<void>;
	on(action: string): Promise<void> {
		this.events.push(action);
		return Promise.resolve();
	}

	shutdown(): Promise<void> {
		this.alive = false;
		return Promise.resolve();
	}

	didSeeAction(action: string): boolean {
		return this.events.some(e => e === action);
	}

	actionCount(action: string): number {
		return this.events.reduce((count, act) => count + (act === action ? 1 : 0), 0);
	}

	wasShutdown() {
		return !this.alive;
	}
}