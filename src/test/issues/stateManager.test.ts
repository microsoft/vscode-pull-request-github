/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import * as vscode from 'vscode';
import { StateManager } from '../../issues/stateManager';
import { CurrentIssue } from '../../issues/currentIssue';
import { USE_BRANCH_FOR_ISSUES, ISSUES_SETTINGS_NAMESPACE } from '../../common/settingKeys';

// Mock classes for testing
class MockFolderRepositoryManager {
	constructor(public repository: { rootUri: vscode.Uri }) {}
}

class MockSingleRepoState {
	currentIssue?: MockCurrentIssue;
	constructor(public folderManager: MockFolderRepositoryManager) {}
}

class MockCurrentIssue {
	stopWorkingCalled = false;
	stopWorkingCheckoutFlag = false;
	issue = { number: 123 };

	async stopWorking(checkoutDefaultBranch: boolean) {
		this.stopWorkingCalled = true;
		this.stopWorkingCheckoutFlag = checkoutDefaultBranch;
	}
}

describe('StateManager branch behavior with useBranchForIssues setting', function () {
	let stateManager: StateManager;
	let mockContext: vscode.ExtensionContext;

	beforeEach(() => {
		mockContext = {
			workspaceState: {
				get: () => undefined,
				update: () => Promise.resolve(),
			},
			subscriptions: [],
		} as any;

		stateManager = new StateManager(undefined as any, undefined as any, mockContext);
		(stateManager as any)._singleRepoStates = new Map();
	});

	it('should not checkout default branch when useBranchForIssues is off', async function () {
		// Mock workspace configuration to return 'off'
		const originalGetConfiguration = vscode.workspace.getConfiguration;
		vscode.workspace.getConfiguration = (section?: string) => {
			if (section === ISSUES_SETTINGS_NAMESPACE) {
				return {
					get: (key: string) => {
						if (key === USE_BRANCH_FOR_ISSUES) {
							return 'off';
						}
						return undefined;
					},
				} as any;
			}
			return originalGetConfiguration(section);
		};

		try {
			// Set up test state
			const mockUri = vscode.Uri.parse('file:///test');
			const mockFolderManager = new MockFolderRepositoryManager({ rootUri: mockUri });
			const mockState = new MockSingleRepoState(mockFolderManager);
			const mockCurrentIssue = new MockCurrentIssue();
			mockState.currentIssue = mockCurrentIssue;

			(stateManager as any)._singleRepoStates.set(mockUri.path, mockState);

			// Call setCurrentIssue with checkoutDefaultBranch = true
			await stateManager.setCurrentIssue(mockState as any, undefined, true, true);

			// Verify that stopWorking was called with false (not the original true)
			assert.strictEqual(mockCurrentIssue.stopWorkingCalled, true, 'stopWorking should have been called');
			assert.strictEqual(mockCurrentIssue.stopWorkingCheckoutFlag, false, 'stopWorking should have been called with checkoutDefaultBranch=false when useBranchForIssues is off');
		} finally {
			// Restore original configuration
			vscode.workspace.getConfiguration = originalGetConfiguration;
		}
	});

	it('should checkout default branch when useBranchForIssues is not off', async function () {
		// Mock workspace configuration to return 'on'
		const originalGetConfiguration = vscode.workspace.getConfiguration;
		vscode.workspace.getConfiguration = (section?: string) => {
			if (section === ISSUES_SETTINGS_NAMESPACE) {
				return {
					get: (key: string) => {
						if (key === USE_BRANCH_FOR_ISSUES) {
							return 'on';
						}
						return undefined;
					},
				} as any;
			}
			return originalGetConfiguration(section);
		};

		try {
			// Set up test state
			const mockUri = vscode.Uri.parse('file:///test');
			const mockFolderManager = new MockFolderRepositoryManager({ rootUri: mockUri });
			const mockState = new MockSingleRepoState(mockFolderManager);
			const mockCurrentIssue = new MockCurrentIssue();
			mockState.currentIssue = mockCurrentIssue;

			(stateManager as any)._singleRepoStates.set(mockUri.path, mockState);

			// Call setCurrentIssue with checkoutDefaultBranch = true
			await stateManager.setCurrentIssue(mockState as any, undefined, true, true);

			// Verify that stopWorking was called with true (preserving the original value)
			assert.strictEqual(mockCurrentIssue.stopWorkingCalled, true, 'stopWorking should have been called');
			assert.strictEqual(mockCurrentIssue.stopWorkingCheckoutFlag, true, 'stopWorking should have been called with checkoutDefaultBranch=true when useBranchForIssues is on');
		} finally {
			// Restore original configuration
			vscode.workspace.getConfiguration = originalGetConfiguration;
		}
	});
});