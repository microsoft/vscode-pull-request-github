/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'path';
import { IPullRequestModel, Commit, IPullRequestManager } from '../../github/interface';
import { TreeNode } from './treeNode';
import { FileChangeNode } from './fileChangeNode';
import { toReviewUri } from '../../common/uri';
import { getGitChangeType } from '../../common/diffHunk';
import { Comment } from '../../common/comment';

export class CommitNode extends TreeNode implements vscode.TreeItem {
	public label: string;
	public collapsibleState: vscode.TreeItemCollapsibleState;

	constructor(
		private readonly pullRequestManager: IPullRequestManager,
		private readonly pullRequest: IPullRequestModel,
		private readonly commit: Commit,
		private readonly comments: Comment[]
	) {
		super();
		this.label = commit.commit.message;
		this.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
	}

	getTreeItem(): vscode.TreeItem {
		return this;
	}

	async getChildren(): Promise<TreeNode[]> {
		const fileChanges = await this.pullRequestManager.getCommitChangedFiles(this.pullRequest, this.commit);


		const fileChangeNodes = fileChanges.map(change => {
			const matchingComments = this.comments.filter(comment => comment.path === change.filename && comment.original_commit_id === this.commit.sha);
			const fileName = change.filename;
			const uri = vscode.Uri.parse(path.join(`commit~${this.commit.sha.substr(0, 8)}`, fileName));
			const fileChangeNode = new FileChangeNode(
				this.pullRequest,
				getGitChangeType(change.status),
				fileName,
				null,
				toReviewUri(uri, fileName, null, this.commit.sha, { base: false }),
				toReviewUri(uri, fileName, null, this.commit.sha, { base: true }),
				[],
				matchingComments,
				this.commit.sha
			);

			fileChangeNode.command = {
				title: 'View Changes',
				command: 'pr.viewChanges',
				arguments: [
					fileChangeNode
				]
			};

			return fileChangeNode;
		});


		return Promise.resolve(fileChangeNodes);
	}

}