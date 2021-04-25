/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import { GitCommitRef, GitPullRequestCommentThread } from 'azure-devops-node-api/interfaces/GitInterfaces';
import * as vscode from 'vscode';
import { FolderRepositoryManager } from '../../azdo/folderRepositoryManager';
import { PullRequestModel } from '../../azdo/pullRequestModel';
import { getGitChangeTypeFromVersionControlChangeType } from '../../common/diffHunk';
import { toReviewUri } from '../../common/uri';
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
		private readonly commit: GitCommitRef,
		private readonly comments: GitPullRequestCommentThread[],
	) {
		super();
		this.label = commit.comment ?? '';
		this.sha = commit.commitId!;
		this.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
		let userIconUri: vscode.Uri | undefined;
		try {
			if (commit.author && commit.author.imageUrl) {
				userIconUri = vscode.Uri.parse(`${commit.author.imageUrl}&s=${64}`);
			}
		} catch (_) {
			// no-op
		}

		this.iconPath = userIconUri;
		this.contextValue = 'commit';
		// eslint-disable-next-line @typescript-eslint/no-unused-expressions
		this.comments;
	}

	getTreeItem(): vscode.TreeItem {
		return this;
	}

	async getChildren(): Promise<TreeNode[]> {
		const fileChanges = await this.pullRequest.getCommitChanges(this.commit);

		const fileChangeNodes = fileChanges.map(change => {
			// TODO Map the file changes with commit id. But this is not possible in Azdo as azdo pr works on iterations not individual commits
			// const matchingComments = this.comments.filter(comment => comment.threadContext?.filePath === change.item?.path && comment.originalCommitId === this.commit.commitId);
			const fileName = change.item?.path ?? change.sourceServerItem ?? '';
			const parentFileName = change.sourceServerItem ?? change.item?.path ?? '';
			const uri = vscode.Uri.parse(path.join(`commit~${this.commit.commitId?.substr(0, 8)}`, fileName));
			const fileChangeNode = new GitFileChangeNode(
				this,
				this.pullRequest,
				getGitChangeTypeFromVersionControlChangeType(change.changeType!),
				fileName,
				undefined,
				toReviewUri(
					uri,
					fileName,
					undefined,
					this.commit.commitId!,
					true,
					{ base: false },
					this.pullRequestManager.repository.rootUri,
				),
				toReviewUri(
					uri,
					parentFileName,
					undefined,
					this.commit.commitId!,
					true,
					{ base: true },
					this.pullRequestManager.repository.rootUri,
				),
				[],
				[], //matchingComments,
				'',
				this.commit.commitId,
			);

			fileChangeNode.command = {
				title: 'View Changes',
				command: 'azdopr.viewChanges',
				arguments: [fileChangeNode],
			};

			return fileChangeNode;
		});

		return Promise.resolve(fileChangeNodes);
	}
}
