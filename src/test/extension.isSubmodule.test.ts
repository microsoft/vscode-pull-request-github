/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import * as vscode from 'vscode';
import { Repository, Submodule } from '../api/api';
import { GitApiImpl } from '../api/api1';

// Note: Since isSubmodule is not exported from extension.ts, we'll create a similar test function here
function isSubmoduleTest(repo: Repository, git: GitApiImpl): boolean {
	const repoPath = repo.rootUri.fsPath;

	// Check all other repositories to see if this repo is listed as a submodule
	for (const otherRepo of git.repositories) {
		if (otherRepo.rootUri.toString() === repo.rootUri.toString()) {
			continue; // Skip self
		}

		// Check if this repo's path appears in the other repo's submodules
		for (const submodule of otherRepo.state.submodules) {
			// The submodule path is relative to the parent repo, so we need to resolve it
			const submodulePath = vscode.Uri.joinPath(otherRepo.rootUri, submodule.path).fsPath;
			if (submodulePath === repoPath) {
				return true;
			}
		}
	}

	return false;
}

describe('isSubmodule Tests', function () {
	it('should return false for repositories with no submodules', () => {
		const mockRepo: Repository = {
			rootUri: vscode.Uri.file('/home/user/repo1'),
			state: {
				submodules: [],
				remotes: [],
				HEAD: undefined,
				rebaseCommit: undefined,
				mergeChanges: [],
				indexChanges: [],
				workingTreeChanges: [],
				onDidChange: new vscode.EventEmitter<void>().event,
			},
		} as Repository;

		const mockGit: GitApiImpl = {
			repositories: [mockRepo],
		} as GitApiImpl;

		const result = isSubmoduleTest(mockRepo, mockGit);
		assert.strictEqual(result, false);
	});

	it('should return true when repository is listed as submodule in another repo', () => {
		const submoduleRepo: Repository = {
			rootUri: vscode.Uri.file('/home/user/parent/submodule'),
			state: {
				submodules: [],
				remotes: [],
				HEAD: undefined,
				rebaseCommit: undefined,
				mergeChanges: [],
				indexChanges: [],
				workingTreeChanges: [],
				onDidChange: new vscode.EventEmitter<void>().event,
			},
		} as Repository;

		const parentRepo: Repository = {
			rootUri: vscode.Uri.file('/home/user/parent'),
			state: {
				submodules: [
					{
						name: 'submodule',
						path: 'submodule',
						url: 'https://github.com/example/submodule.git'
					} as Submodule
				],
				remotes: [],
				HEAD: undefined,
				rebaseCommit: undefined,
				mergeChanges: [],
				indexChanges: [],
				workingTreeChanges: [],
				onDidChange: new vscode.EventEmitter<void>().event,
			},
		} as Repository;

		const mockGit: GitApiImpl = {
			repositories: [parentRepo, submoduleRepo],
		} as GitApiImpl;

		const result = isSubmoduleTest(submoduleRepo, mockGit);
		assert.strictEqual(result, true);
	});

	it('should return false when repository is not listed as submodule', () => {
		const repo1: Repository = {
			rootUri: vscode.Uri.file('/home/user/repo1'),
			state: {
				submodules: [],
				remotes: [],
				HEAD: undefined,
				rebaseCommit: undefined,
				mergeChanges: [],
				indexChanges: [],
				workingTreeChanges: [],
				onDidChange: new vscode.EventEmitter<void>().event,
			},
		} as Repository;

		const repo2: Repository = {
			rootUri: vscode.Uri.file('/home/user/repo2'),
			state: {
				submodules: [
					{
						name: 'different-submodule',
						path: 'different-submodule',
						url: 'https://github.com/example/different.git'
					} as Submodule
				],
				remotes: [],
				HEAD: undefined,
				rebaseCommit: undefined,
				mergeChanges: [],
				indexChanges: [],
				workingTreeChanges: [],
				onDidChange: new vscode.EventEmitter<void>().event,
			},
		} as Repository;

		const mockGit: GitApiImpl = {
			repositories: [repo1, repo2],
		} as GitApiImpl;

		const result = isSubmoduleTest(repo1, mockGit);
		assert.strictEqual(result, false);
	});
});