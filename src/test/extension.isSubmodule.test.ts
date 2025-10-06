/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import * as vscode from 'vscode';
import { Repository, Submodule } from '../api/api';
import { GitApiImpl } from '../api/api1';
import { isSubmodule } from '../common/gitUtils'

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
		} as Partial<Repository> as Repository;

		const mockGit: GitApiImpl = {
			repositories: [mockRepo],
		} as GitApiImpl;

		const result = isSubmodule(mockRepo, mockGit);
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
		} as Partial<Repository> as Repository;

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
		} as Partial<Repository> as Repository;

		const mockGit: GitApiImpl = {
			repositories: [parentRepo, submoduleRepo],
		} as GitApiImpl;

		const result = isSubmodule(submoduleRepo, mockGit);
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
		} as Partial<Repository> as Repository;

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
		} as Partial<Repository> as Repository;

		const mockGit: GitApiImpl = {
			repositories: [repo1, repo2],
		} as GitApiImpl;

		const result = isSubmodule(repo1, mockGit);
		assert.strictEqual(result, false);
	});
});
