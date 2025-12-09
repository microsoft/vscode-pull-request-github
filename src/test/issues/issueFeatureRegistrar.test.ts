/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import * as vscode from 'vscode';
import { IssueFeatureRegistrar } from '../../issues/issueFeatureRegistrar';
import { StateManager } from '../../issues/stateManager';
import { WORKING_BASE_BRANCH, ISSUES_SETTINGS_NAMESPACE } from '../../common/settingKeys';

// Mock classes for testing
class MockStateManager {
	setCurrentIssueCalled = false;
	setCurrentIssueCheckoutFlag = false;

	async setCurrentIssue(repoManager: any, issue: any, checkoutDefaultBranch: boolean) {
		this.setCurrentIssueCalled = true;
		this.setCurrentIssueCheckoutFlag = checkoutDefaultBranch;
	}
}

class MockFolderRepositoryManager {
	async findUpstreamForItem() {
		return { needsFork: false, remote: {} };
	}
}

class MockIssueModel {
	githubRepository = { remote: {} };
	remote = {};
}

describe('IssueFeatureRegistrar workingBaseBranch setting', function () {
	let issueFeatureRegistrar: IssueFeatureRegistrar;
	let mockStateManager: MockStateManager;
	let originalGetConfiguration: typeof vscode.workspace.getConfiguration;
	let originalShowQuickPick: typeof vscode.window.showQuickPick;

	beforeEach(() => {
		mockStateManager = new MockStateManager();
		issueFeatureRegistrar = new IssueFeatureRegistrar(
			undefined as any,
			undefined as any,
			undefined as any,
			undefined as any,
			undefined as any,
			mockStateManager as any,
			undefined as any
		);

		originalGetConfiguration = vscode.workspace.getConfiguration;
		originalShowQuickPick = vscode.window.showQuickPick;
	});

	afterEach(() => {
		vscode.workspace.getConfiguration = originalGetConfiguration;
		vscode.window.showQuickPick = originalShowQuickPick;
	});

	it('should not checkout default branch when workingBaseBranch is currentBranch', async function () {
		// Mock workspace configuration to return 'currentBranch'
		vscode.workspace.getConfiguration = (section?: string) => {
			if (section === ISSUES_SETTINGS_NAMESPACE) {
				return {
					get: (key: string) => {
						if (key === WORKING_BASE_BRANCH) {
							return 'currentBranch';
						}
						return undefined;
					},
				} as any;
			}
			return originalGetConfiguration(section);
		};

		const mockRepoManager = new MockFolderRepositoryManager();
		const mockIssueModel = new MockIssueModel();

		await issueFeatureRegistrar.doStartWorking(mockRepoManager as any, mockIssueModel as any);

		assert.strictEqual(mockStateManager.setCurrentIssueCalled, true, 'setCurrentIssue should have been called');
		assert.strictEqual(mockStateManager.setCurrentIssueCheckoutFlag, false, 'setCurrentIssue should have been called with checkoutDefaultBranch=false when workingBaseBranch is currentBranch');
	});

	it('should checkout default branch when workingBaseBranch is defaultBranch', async function () {
		// Mock workspace configuration to return 'defaultBranch'
		vscode.workspace.getConfiguration = (section?: string) => {
			if (section === ISSUES_SETTINGS_NAMESPACE) {
				return {
					get: (key: string) => {
						if (key === WORKING_BASE_BRANCH) {
							return 'defaultBranch';
						}
						return undefined;
					},
				} as any;
			}
			return originalGetConfiguration(section);
		};

		const mockRepoManager = new MockFolderRepositoryManager();
		const mockIssueModel = new MockIssueModel();

		await issueFeatureRegistrar.doStartWorking(mockRepoManager as any, mockIssueModel as any);

		assert.strictEqual(mockStateManager.setCurrentIssueCalled, true, 'setCurrentIssue should have been called');
		assert.strictEqual(mockStateManager.setCurrentIssueCheckoutFlag, true, 'setCurrentIssue should have been called with checkoutDefaultBranch=true when workingBaseBranch is defaultBranch');
	});

	it('should prompt user when workingBaseBranch is prompt and user selects current branch', async function () {
		// Mock workspace configuration to return 'prompt'
		vscode.workspace.getConfiguration = (section?: string) => {
			if (section === ISSUES_SETTINGS_NAMESPACE) {
				return {
					get: (key: string) => {
						if (key === WORKING_BASE_BRANCH) {
							return 'prompt';
						}
						return undefined;
					},
				} as any;
			}
			return originalGetConfiguration(section);
		};

		// Mock showQuickPick to return 'Current Branch'
		vscode.window.showQuickPick = (async (items: any, options?: any) => {
			// Return the first item which should be 'Current Branch'
			return vscode.l10n.t('Current Branch');
		}) as any;

		const mockRepoManager = new MockFolderRepositoryManager();
		const mockIssueModel = new MockIssueModel();

		await issueFeatureRegistrar.doStartWorking(mockRepoManager as any, mockIssueModel as any);

		assert.strictEqual(mockStateManager.setCurrentIssueCalled, true, 'setCurrentIssue should have been called');
		assert.strictEqual(mockStateManager.setCurrentIssueCheckoutFlag, false, 'setCurrentIssue should have been called with checkoutDefaultBranch=false when user selects Current Branch');
	});

	it('should prompt user when workingBaseBranch is prompt and user selects default branch', async function () {
		// Mock workspace configuration to return 'prompt'
		vscode.workspace.getConfiguration = (section?: string) => {
			if (section === ISSUES_SETTINGS_NAMESPACE) {
				return {
					get: (key: string) => {
						if (key === WORKING_BASE_BRANCH) {
							return 'prompt';
						}
						return undefined;
					},
				} as any;
			}
			return originalGetConfiguration(section);
		};

		// Mock showQuickPick to return 'Default Branch'
		vscode.window.showQuickPick = (async (items: any, options?: any) => {
			// Return the second item which should be 'Default Branch'
			return vscode.l10n.t('Default Branch');
		}) as any;

		const mockRepoManager = new MockFolderRepositoryManager();
		const mockIssueModel = new MockIssueModel();

		await issueFeatureRegistrar.doStartWorking(mockRepoManager as any, mockIssueModel as any);

		assert.strictEqual(mockStateManager.setCurrentIssueCalled, true, 'setCurrentIssue should have been called');
		assert.strictEqual(mockStateManager.setCurrentIssueCheckoutFlag, true, 'setCurrentIssue should have been called with checkoutDefaultBranch=true when user selects Default Branch');
	});

	it('should cancel operation when workingBaseBranch is prompt and user cancels', async function () {
		// Mock workspace configuration to return 'prompt'
		vscode.workspace.getConfiguration = (section?: string) => {
			if (section === ISSUES_SETTINGS_NAMESPACE) {
				return {
					get: (key: string) => {
						if (key === WORKING_BASE_BRANCH) {
							return 'prompt';
						}
						return undefined;
					},
				} as any;
			}
			return originalGetConfiguration(section);
		};

		// Mock showQuickPick to return undefined (user cancelled)
		vscode.window.showQuickPick = (async (items: any, options?: any) => {
			return undefined;
		}) as any;

		const mockRepoManager = new MockFolderRepositoryManager();
		const mockIssueModel = new MockIssueModel();

		await issueFeatureRegistrar.doStartWorking(mockRepoManager as any, mockIssueModel as any);

		assert.strictEqual(mockStateManager.setCurrentIssueCalled, false, 'setCurrentIssue should not have been called when user cancels prompt');
	});
});
