/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { getGitChangeType } from '../../common/diffHunk';
import { toReviewUri } from '../../common/uri';
import { OctokitCommon } from '../../github/common';
import { FolderRepositoryManager } from '../../github/folderRepositoryManager';
import { IResolvedPullRequestModel, PullRequestModel } from '../../github/pullRequestModel';
import { GitFileChangeNode } from './fileChangeNode';
import { TreeNode, TreeNodeParent } from './treeNode';

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

		const fileChangeNodes = fileChanges.map(change => {
			const fileName = change.filename!;
			const uri = vscode.Uri.parse(path.posix.join(`commit~${this.commit.sha.substr(0, 8)}`, fileName));
			const fileChangeNode = new GitFileChangeNode(
				this,
				this.pullRequestManager,
				this.pullRequest as (PullRequestModel & IResolvedPullRequestModel),
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
				this.commit.sha,
				this.isCurrent
			);

			fileChangeNode.useViewChangesCommand();

			return fileChangeNode;
		});

		return Promise.resolve(fileChangeNodes);
	}
}
