/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import * as vscode from 'vscode';
import { SinonSandbox, createSandbox } from 'sinon';

import { SessionLogViewManager } from '../../view/sessionLogView';
import { MockTelemetry } from '../mocks/mockTelemetry';
import { MockExtensionContext } from '../mocks/mockExtensionContext';
import { CredentialStore } from '../../github/credentials';
import { RepositoriesManager } from '../../github/repositoriesManager';
import { CopilotRemoteAgentManager, IAPISessionLogs } from '../../github/copilotRemoteAgent';
import { SessionPullInfo } from '../../common/timelineEvent';
import * as copilotApi from '../../github/copilotApi';

describe('SessionLogViewManager', function () {
	let sinon: SinonSandbox;
	let sessionLogViewManager: SessionLogViewManager;
	let context: MockExtensionContext;
	let telemetry: MockTelemetry;
	let credentialStore: CredentialStore;
	let reposManager: RepositoriesManager;
	let copilotAgentManager: CopilotRemoteAgentManager;

	beforeEach(function () {
		sinon = createSandbox();
		context = new MockExtensionContext();
		telemetry = new MockTelemetry();
		credentialStore = new CredentialStore(telemetry, context);
		
		// Mock the managers with minimal implementation
		reposManager = {} as RepositoriesManager;
		copilotAgentManager = {} as CopilotRemoteAgentManager;
		
		sessionLogViewManager = new SessionLogViewManager(
			credentialStore,
			context,
			reposManager,
			telemetry,
			copilotAgentManager
		);
	});

	afterEach(function () {
		sinon.restore();
		sessionLogViewManager?.dispose();
	});

	describe('Panel Reuse', function () {
		it('should create a new panel when none exists', async function () {
			const createWebviewPanelSpy = sinon.spy(vscode.window, 'createWebviewPanel');
			
			// Mock getCopilotApi to return a valid API
			const mockCopilotApi = {
				getSessionInfo: sinon.stub().resolves({ state: 'completed' }),
				getLogsFromSession: sinon.stub().resolves([])
			};
			sinon.stub(copilotApi, 'getCopilotApi').resolves(mockCopilotApi);

			const mockLogs: IAPISessionLogs = { 
				sessionId: 'test-session-1',
				logs: 'mock log data'
			};
			const mockPullInfo: SessionPullInfo = {
				host: 'github.com',
				owner: 'test-owner',
				repo: 'test-repo',
				pullId: 123
			};

			await sessionLogViewManager.open(mockLogs, mockPullInfo);

			assert.strictEqual(createWebviewPanelSpy.callCount, 1);
		});

		it('should reuse existing panel for the same session', async function () {
			const createWebviewPanelSpy = sinon.spy(vscode.window, 'createWebviewPanel');
			
			// Mock getCopilotApi to return a valid API
			const mockCopilotApi = {
				getSessionInfo: sinon.stub().resolves({ state: 'completed' }),
				getLogsFromSession: sinon.stub().resolves([])
			};
			sinon.stub(copilotApi, 'getCopilotApi').resolves(mockCopilotApi);

			const mockLogs: IAPISessionLogs = { 
				sessionId: 'test-session-1',
				logs: 'mock log data'
			};
			const mockPullInfo: SessionPullInfo = {
				host: 'github.com',
				owner: 'test-owner',
				repo: 'test-repo',
				pullId: 123
			};

			// First call should create a panel
			await sessionLogViewManager.open(mockLogs, mockPullInfo);
			assert.strictEqual(createWebviewPanelSpy.callCount, 1);

			// Second call with same sessionId should not create a new panel
			await sessionLogViewManager.open(mockLogs, mockPullInfo);
			assert.strictEqual(createWebviewPanelSpy.callCount, 1, 'Should not create a second panel for the same session');
		});

		it('should create different panels for different sessions', async function () {
			const createWebviewPanelSpy = sinon.spy(vscode.window, 'createWebviewPanel');
			
			// Mock getCopilotApi to return a valid API
			const mockCopilotApi = {
				getSessionInfo: sinon.stub().resolves({ state: 'completed' }),
				getLogsFromSession: sinon.stub().resolves([])
			};
			sinon.stub(copilotApi, 'getCopilotApi').resolves(mockCopilotApi);

			const mockLogs1: IAPISessionLogs = { 
				sessionId: 'test-session-1',
				logs: 'mock log data 1'
			};
			const mockLogs2: IAPISessionLogs = { 
				sessionId: 'test-session-2',
				logs: 'mock log data 2'
			};
			const mockPullInfo: SessionPullInfo = {
				host: 'github.com',
				owner: 'test-owner',
				repo: 'test-repo',
				pullId: 123
			};

			// First call should create a panel
			await sessionLogViewManager.open(mockLogs1, mockPullInfo);
			assert.strictEqual(createWebviewPanelSpy.callCount, 1);

			// Call with different sessionId should create a new panel
			await sessionLogViewManager.open(mockLogs2, mockPullInfo);
			assert.strictEqual(createWebviewPanelSpy.callCount, 2, 'Should create a new panel for different session');
		});
	});
});