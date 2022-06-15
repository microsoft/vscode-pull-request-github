/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { getGitChangeType } from '../../common/diffHunk';
import { FILE_LIST_LAYOUT } from '../../common/settingKeys';
import { toReviewUri } from '../../common/uri';
import { OctokitCommon } from '../../github/common';
import { FolderRepositoryManager, SETTINGS_NAMESPACE } from '../../github/folderRepositoryManager';
import { IResolvedPullRequestModel, PullRequestModel } from '../../github/pullRequestModel';
import { GitFileChangeModel } from '../fileChangeModel';
import { DirectoryTreeNode } from './directoryTreeNode';
import { GitFileChangeNode } from './fileChangeNode';
import { LabelOnlyNode, TreeNode, TreeNodeParent } from './treeNode';

export class CommitNode extends TreeNode implements vscode.TreeItem {
	public sha: string;
	public collapsibleState: vscode.TreeItemCollapsibleState;
	public iconPath: vscode.Uri | undefined;
	public contextValue?: string;

	constructor(
		public parent: TreeNodeParent,
		private readonly pullRequestManager: FolderRepositoryManager,
		private readonly pullRequest: PullRequestModel,
		private readonly commit: OctokitCommon.PullsListCommitsResponseItem,
		private readonly isCurrent: boolean
	) {
		super();
		this.label = commit.commit.message;
		this.sha = commit.sha;
		this.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
		let userIconUri: vscode.Uri | undefined;
		try {
			if (commit.author && commit.author.avatar_url) {
				userIconUri = vscode.Uri.parse(`${commit.author.avatar_url}&s=${64}`);
			}
		} catch (_) {
			// no-op
		}

		this.iconPath = userIconUri;
		this.contextValue = 'commit';
	}

	getTreeItem(): vscode.TreeItem {
		return this;
	}

	async getChildren(): Promise<TreeNode[]> {
		const fileChanges = (await this.pullRequest.getCommitChangedFiles(this.commit)) ?? [];

		if (fileChanges.length === 0) {
			return [new LabelOnlyNode('No changed files')];
		}

		const fileChangeNodes = fileChanges.map(change => {
			const fileName = change.filename!;
			const uri = vscode.Uri.parse(path.posix.join(`commit~${this.commit.sha.substr(0, 8)}`, fileName));
			const changeModel = new GitFileChangeModel(
				this.pullRequestManager,
				this.pullRequest,
				{
					status: getGitChangeType(change.status!),
					fileName,
					blobUrl: undefined
				},
				toReviewUri(
					uri,
					fileName,
					undefined,
					this.commit.sha,
					true,
					{ base: false },
					this.pullRequestManager.repository.rootUri,
				),
				toReviewUri(
					uri,
					fileName,
					undefined,
					this.commit.sha,
					true,
					{ base: true },
					this.pullRequestManager.repository.rootUri,
				),
				this.commit.sha);
			const fileChangeNode = new GitFileChangeNode(
				this,
				this.pullRequestManager,
				this.pullRequest as (PullRequestModel & IResolvedPullRequestModel),
				changeModel,
				this.isCurrent
			);

			fileChangeNode.useViewChangesCommand();

			return fileChangeNode;
		});

		let result: TreeNode[] = [];
		const layout = vscode.workspace.getConfiguration(SETTINGS_NAMESPACE).get<string>(FILE_LIST_LAYOUT);
		if (layout === 'tree') {
			// tree view
			const dirNode = new DirectoryTreeNode(this, '');
			fileChangeNodes.forEach(f => dirNode.addFile(f));
			dirNode.finalize();
			if (dirNode.label === '') {
				// nothing on the root changed, pull children to parent
				result.push(...dirNode.children);
			} else {
				result.push(dirNode);
			}
		} else {
			// flat view
			result = fileChangeNodes;
		}
		return Promise.resolve(result);
	}
}
