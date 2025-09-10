/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as temp from 'temp';
import { ExtensionContext, Uri, SecretStorage, Event, SecretStorageChangeEvent, EventEmitter } from 'vscode';

import { InMemoryMemento } from './inMemoryMemento';

export class MockExtensionContext implements ExtensionContext {
	extensionPath: string;

	workspaceState = new InMemoryMemento();
	globalState = new InMemoryMemento();
	secrets = new (class implements SecretStorage {
		get(key: string): Thenable<string | undefined> {
			throw new Error('Method not implemented.');
		}
		store(key: string, value: string): Thenable<void> {
			throw new Error('Method not implemented.');
		}
		keys(): Thenable<string[]> {
			throw new Error('Method not implemented.');
		}
		delete(key: string): Thenable<void> {
			throw new Error('Method not implemented.');
		}
		onDidChange!: Event<SecretStorageChangeEvent>;
	})();
	subscriptions: { dispose(): any }[] = [];

	storagePath: string;
	globalStoragePath: string;
	logPath: string;
	extensionUri: Uri = Uri.file(path.resolve(__dirname, '..'));
	environmentVariableCollection: any;
	extensionMode: any;

	logUri: Uri;

	storageUri: Uri;

	globalStorageUri: Uri;

	extensionRuntime: any;
	extension: any;
	isNewInstall: any;
	languageModelAccessInformation = {
		onDidChange: new EventEmitter<void>().event,

		canSendRequest: (_chat: any) => {
			return undefined;
		}
	};

	constructor() {
		this.extensionPath = path.resolve(__dirname, '..');
		this.extensionUri = Uri.file(this.extensionPath);
		this.storagePath = temp.mkdirSync('storage-path');
		this.storageUri = Uri.file(this.storagePath);
		this.globalStoragePath = temp.mkdirSync('global-storage-path');
		this.globalStorageUri = Uri.file(this.globalStoragePath);
		this.logPath = temp.mkdirSync('log-path');
		this.logUri = Uri.file(this.logPath);
	}

	asAbsolutePath(relativePath: string): string {
		return path.resolve(this.extensionPath, relativePath);
	}

	dispose() {
		this.subscriptions.forEach(sub => sub.dispose());
	}
}
