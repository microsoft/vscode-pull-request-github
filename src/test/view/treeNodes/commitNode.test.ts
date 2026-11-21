/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import { createSandbox, SinonSandbox, SinonStubbedInstance } from 'sinon';
import * as vscode from 'vscode';
import { ViewedState } from '../../../common/comment';
import { GitChangeType } from '../../../common/file';
import { GitHubRef } from '../../../common/githubRef';
import { FILE_LIST_LAYOUT } from '../../../common/settingKeys';
import { OctokitCommon } from '../../../github/common';
import { FolderRepositoryManager } from '../../../github/folderRepositoryManager';
import { PullRequestModel } from '../../../github/pullRequestModel';
import { GitFileChangeModel } from '../../../view/fileChangeModel';
import { CommitNode } from '../../../view/treeNodes/commitNode';
import { DirectoryTreeNode } from '../../../view/treeNodes/directoryTreeNode';
import { FileChangeNode, GitFileChangeNode } from '../../../view/treeNodes/fileChangeNode';
import { BaseTreeNode, TreeNode } from '../../../view/treeNodes/treeNode';
import { MockRepository } from '../../mocks/mockRepository';
import { mockTreeViewWorkbench } from '../../mocks/mockTreeViewWorkbench';

function createCommit(sha: string): OctokitCommon.PullsListCommitsResponseItem {
	return {
		sha,
		node_id: sha,
		url: '',
		html_url: '',
		comments_url: '',
		author: null,
		committer: null,
		parents: [],
		commit: {
			message: 'Test commit',
			author: null,
			committer: null,
			url: '',
			comment_count: 0,
			tree: { sha, url: '' },
			verification: { verified: false, reason: 'unsigned', signature: null, payload: null, verified_at: null },
		},
	};
}

describe('CommitNode checkboxes', function () {
	let sinon: SinonSandbox;
	let manager: FolderRepositoryManager & SinonStubbedInstance<FolderRepositoryManager>;
	let pullRequest: PullRequestModel & SinonStubbedInstance<PullRequestModel>;
	let parent: BaseTreeNode;
	let nodes: TreeNode[];
	let layout: string;

	beforeEach(function () {
		sinon = createSandbox();
		mockTreeViewWorkbench(sinon);
		nodes = [];
		layout = 'tree';
		const configuration: vscode.WorkspaceConfiguration = {
			get: sinon.stub().callsFake((key: string, fallback?: unknown) => key === FILE_LIST_LAYOUT ? layout : fallback),
			has: sinon.stub().returns(false),
			inspect: sinon.stub().returns(undefined),
			update: sinon.stub().rejects(new Error('Tests must not write settings')),
		};
		sinon.stub(vscode.workspace, 'getConfiguration').returns(configuration);
		manager = sinon.createStubInstance(FolderRepositoryManager) as typeof manager;
		sinon.stub(manager, 'repository').get(() => new MockRepository());
		pullRequest = sinon.createStubInstance(PullRequestModel) as typeof pullRequest;
		pullRequest.head = new GitHubRef('main', 'owner:main', 'head', 'https://github.com/owner/repo.git', 'owner', 'repo', false);
		sinon.stub(pullRequest, 'fileChangeViewedState').get(() => ({}));
		sinon.stub(pullRequest, 'reviewThreadsCache').get(() => []);
		pullRequest.onDidChangeReviewThreads = sinon.stub<Parameters<PullRequestModel['onDidChangeReviewThreads']>, vscode.Disposable>().returns(new vscode.Disposable(() => { }));
		pullRequest.onDidChangeFileViewedState = sinon.stub<Parameters<PullRequestModel['onDidChangeFileViewedState']>, vscode.Disposable>().returns(new vscode.Disposable(() => { }));
		parent = {
			refresh: sinon.stub(),
			reveal: sinon.stub().resolves(),
			children: undefined,
			view: vscode.window.createTreeView<TreeNode>('test', {
				treeDataProvider: {
					getTreeItem: node => node.getTreeItem(),
					getChildren: () => [],
				},
			}),
		};
	});

	afterEach(function () {
		nodes.forEach(node => node.dispose());
		parent.view.dispose();
		sinon.restore();
	});

	async function assertNoCheckboxes(children: TreeNode[]): Promise<{ files: number; directories: number }> {
		let files = 0;
		let directories = 0;
		for (const child of children) {
			nodes.push(child);
			assert.strictEqual((await child.getTreeItem()).checkboxState, undefined);
			if (child instanceof DirectoryTreeNode) {
				directories++;
				child.updateCheckboxFromChildren();
				assert.strictEqual(child.checkboxState, undefined);
				const descendants = await assertNoCheckboxes(await child.getChildren());
				files += descendants.files;
				directories += descendants.directories;
			} else {
				assert.ok(child instanceof FileChangeNode);
				files++;
				for (const state of [ViewedState.VIEWED, ViewedState.UNVIEWED]) {
					child.updateViewed(state);
					assert.strictEqual(child.getTreeItem().checkboxState, undefined);
				}
			}
		}
		return { files, directories };
	}

	for (const sha of ['head', 'older']) {
		for (const testCase of [
			{ layout: 'tree', name: 'nested directories and root files', files: ['root.ts', 'src/a.ts', 'src/utils/b.ts', 'test/unit/c.ts'], directories: 3 },
			{ layout: 'tree', name: 'compacted directories', files: ['src/nested/a.ts', 'src/nested/utils/b.ts'], directories: 2 },
			{ layout: 'tree', name: 'root files only', files: ['a.ts', 'b.ts'], directories: 0 },
			{ layout: 'flat', name: 'flat files', files: ['root.ts', 'src/a.ts', 'src/utils/b.ts'], directories: 0 },
		]) {
			it(`has no checkboxes for ${testCase.name} in the ${sha} commit`, async function () {
				layout = testCase.layout;
				pullRequest.getCommitChangedFiles.resolves(testCase.files.map(filename => ({
					filename,
					sha,
					status: 'modified',
					additions: 1,
					deletions: 0,
					changes: 1,
					blob_url: '',
					raw_url: '',
					contents_url: '',
				})));
				const node = new CommitNode(parent, manager, pullRequest, createCommit(sha), sha === 'head');
				nodes.push(node);
				assert.strictEqual((await node.getTreeItem()).checkboxState, undefined);
				const counts = await assertNoCheckboxes(await node.getChildren());
				assert.deepStrictEqual(counts, { files: testCase.files.length, directories: testCase.directories });
			});
		}
	}

	it('preserves file and directory checkboxes outside the commits tree', function () {
		pullRequest.isResolved.returns(true);
		assert.ok(pullRequest.isResolved());
		const directory = new DirectoryTreeNode(parent, 'src');
		const uri = vscode.Uri.joinPath(manager.repository.rootUri, 'src/a.ts');
		const model = new GitFileChangeModel(manager, pullRequest, {
			status: GitChangeType.MODIFY,
			fileName: 'src/a.ts',
			blobUrl: undefined,
		}, uri, uri, 'head');
		const file = new GitFileChangeNode(directory, manager, pullRequest, model);
		directory._children.push(file);
		nodes.push(directory, file);

		file.getTreeItem();
		directory.getTreeItem();
		assert.strictEqual(file.checkboxState?.state, vscode.TreeItemCheckboxState.Unchecked);
		assert.strictEqual(directory.checkboxState?.state, vscode.TreeItemCheckboxState.Unchecked);
		file.updateViewed(ViewedState.VIEWED);
		directory.getTreeItem();
		assert.strictEqual(file.checkboxState?.state, vscode.TreeItemCheckboxState.Checked);
		assert.strictEqual(directory.checkboxState?.state, vscode.TreeItemCheckboxState.Checked);
	});
});
