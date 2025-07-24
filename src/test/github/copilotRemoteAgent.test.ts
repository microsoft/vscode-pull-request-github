/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as vscode from 'vscode';
import { CredentialStore } from '../../github/credentials';
import { CopilotRemoteAgentManager } from '../../github/copilotRemoteAgent';
import { RepositoriesManager } from '../../github/repositoriesManager';
import { ITelemetry } from '../../common/telemetry';

suite('CopilotRemoteAgentManager', () => {
	let credentialStore: CredentialStore;
	let repositoriesManager: RepositoriesManager;
	let telemetry: ITelemetry;
	let manager: CopilotRemoteAgentManager;

	setup(() => {
		// Create mock objects
		credentialStore = {} as CredentialStore;
		repositoriesManager = {} as RepositoriesManager;
		telemetry = {} as ITelemetry;
		
		// Mock the necessary properties to avoid constructor errors
		(credentialStore as any).onDidChangeSessions = () => ({ dispose: () => {} });
		(repositoriesManager as any).onDidChangeFolderRepositories = () => ({ dispose: () => {} });
		(repositoriesManager as any).folderManagers = [];
		
		manager = new CopilotRemoteAgentManager(credentialStore, repositoriesManager, telemetry);
	});

	teardown(() => {
		manager.dispose();
	});

	test('should have onDidChangeChatSessions event', () => {
		assert.ok(manager.onDidChangeChatSessions, 'onDidChangeChatSessions event should exist');
		assert.strictEqual(typeof manager.onDidChangeChatSessions, 'function', 'onDidChangeChatSessions should be a function');
	});

	test('should have refreshChatSessions method', () => {
		assert.ok(manager.refreshChatSessions, 'refreshChatSessions method should exist');
		assert.strictEqual(typeof manager.refreshChatSessions, 'function', 'refreshChatSessions should be a function');
	});

	test('refreshChatSessions should fire onDidChangeChatSessions event', (done) => {
		let eventFired = false;
		
		// Subscribe to the event
		const disposable = manager.onDidChangeChatSessions(() => {
			eventFired = true;
			disposable.dispose();
			done();
		});

		// Trigger the refresh
		manager.refreshChatSessions();

		// Cleanup if event doesn't fire within timeout
		setTimeout(() => {
			if (!eventFired) {
				disposable.dispose();
				done(new Error('onDidChangeChatSessions event was not fired'));
			}
		}, 100);
	});
});