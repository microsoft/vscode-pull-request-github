/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import * as vscode from 'vscode';
import { DataUri } from '../../common/uri';
import { IAccount, AccountType } from '../../github/interface';

describe('DataUri.avatarCirclesAsImageDataUris', () => {
	let mockContext: vscode.ExtensionContext;
	let originalFetch: any;

	beforeEach(() => {
		// Save original fetch
		originalFetch = global.fetch;

		// Create a mock extension context
		mockContext = {
			globalStorageUri: vscode.Uri.file('/tmp/test-storage'),
		} as any as vscode.ExtensionContext;
	});

	afterEach(() => {
		// Restore original fetch
		global.fetch = originalFetch;
	});

	it('should handle TLS certificate errors gracefully without crashing', async () => {
		// Mock user with avatar URL
		const testUser: IAccount = {
			login: 'testuser',
			id: '123',
			avatarUrl: 'https://avatars.githubusercontent.com/u/123?v=4',
			url: 'https://github.com/testuser',
			accountType: AccountType.User
		};

		// Mock fetch to simulate TLS certificate error
		global.fetch = () => Promise.reject(
			new Error('request to https://avatars.githubusercontent.com/u/123?v=4 failed, reason: self signed certificate in certificate chain')
		);

		// Mock vscode.workspace.fs to simulate cache miss
		const originalReadFile = vscode.workspace.fs.readFile;
		const originalWriteFile = vscode.workspace.fs.writeFile;
		const originalCreateDirectory = vscode.workspace.fs.createDirectory;

		vscode.workspace.fs.readFile = () => Promise.reject(new Error('Cache miss'));
		vscode.workspace.fs.writeFile = () => Promise.resolve();
		vscode.workspace.fs.createDirectory = () => Promise.resolve();

		try {
			// This should not throw an error even with TLS issues
			const results = await DataUri.avatarCirclesAsImageDataUris(mockContext, [testUser], 20, 20);

			// Should return array with undefined for failed fetches
			assert.strictEqual(results.length, 1);
			assert.strictEqual(results[0], undefined);
		} finally {
			// Restore original functions
			vscode.workspace.fs.readFile = originalReadFile;
			vscode.workspace.fs.writeFile = originalWriteFile;
			vscode.workspace.fs.createDirectory = originalCreateDirectory;
		}
	});
});