/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import * as vscode from 'vscode';
import { BaseTreeNode, TreeNode } from '../../../view/treeNodes/treeNode';
import { RepositoryChangesNode } from '../../../view/treeNodes/repositoryChangesNode';

function disposable(): vscode.Disposable {
	return { dispose: () => { } };
}

describe('RepositoryChangesNode', function () {
	// Verifies that VS Code can resolve the visible category nodes through their rendered parent chain.
	it('parents the category nodes to the repository changes node', async function () {
		const parent: BaseTreeNode = {
			reveal: async () => { },
			refresh: () => { },
			children: undefined,
			view: {
				visible: true,
				onDidChangeVisibility: () => disposable(),
			} as unknown as vscode.TreeView<TreeNode>,
		};
		const pullRequestModel = {
			title: 'Pull request title',
			number: 1,
			author: { avatarUrl: '' },
			remote: { owner: 'owner', repositoryName: 'repository' },
			item: { isRemoteHeadDeleted: false },
			hasChangesSinceLastReview: false,
			showChangesSinceReview: false,
			onDidChange: () => disposable(),
			onDidChangeReviewThreads: () => disposable(),
			onDidChangeFileViewedState: () => disposable(),
			equals: () => true,
		};
		const folderRepositoryManager = {
			repository: {},
			context: {},
			activePullRequest: pullRequestModel,
			isPullRequestAssociatedWithOpenRepository: () => true,
		};
		const reviewModel = {
			onDidChangeLocalFileChanges: () => disposable(),
		};
		const node = new RepositoryChangesNode(
			parent,
			pullRequestModel as any,
			folderRepositoryManager as any,
			reviewModel as any,
			{ progress: Promise.resolve() } as any,
		);
		let children: TreeNode[] = [];

		try {
			children = await node.getChildren();
			const [filesNode, commitsNode] = children;
			assert.strictEqual(filesNode.getParent(), node);
			assert.strictEqual(commitsNode.getParent(), node);
		} finally {
			children.forEach(child => child.dispose());
			node.dispose();
		}
	});
});
