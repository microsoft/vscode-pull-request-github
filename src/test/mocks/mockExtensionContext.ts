import * as path from 'path';
import sinon = require('sinon');
import * as temp from 'temp';
import { ExtensionContext, SecretStorage, Uri } from 'vscode';

import { InMemoryMemento } from './inMemoryMemento';

export class MockExtensionContext implements ExtensionContext {
	extensionPath = path.resolve(__dirname, '..');

	workspaceState = new InMemoryMemento();
	globalState = new InMemoryMemento();
	subscriptions: { dispose(): any }[] = [];

	storagePath: string;
	globalStoragePath: string;
	logPath: string;
	extensionUri: Uri;
	environmentVariableCollection: any;
	extensionMode: any;

	logUri: Uri;

	storageUri: Uri;

	globalStorageUri: Uri;

	extensionRuntime: any;
	secrets: SecretStorage;

	extension: any;

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

export const createFakeSecretStorage = (): SecretStorage => {
	const secretStorage = <SecretStorage>{};

	secretStorage.get = sinon.stub().returns(process.env.VSCODE_PR_AZDO_TEST_PAT);
	secretStorage.store = sinon.stub();
	secretStorage.delete = sinon.stub();
	secretStorage.onDidChange = sinon.stub();
	return secretStorage;
};
