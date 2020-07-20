/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'path';
import { Octokit } from '@octokit/rest';
import { TreeNode } from './treeNode';
import { GitFileChangeNode } from './fileChangeNode';
import { toReviewUri } from '../../common/uri';
import { getGitChangeType } from '../../common/diffHunk';
import { IComment } from '../../common/comment';
import { PullRequestManager } from '../../github/pullRequestManager';
import { PullRequestModel } from '../../github/pullRequestModel';

export class CommitNode extends TreeNode implements vscode.TreeItem {
	public label: string;
	public sha: string;
	public collapsibleState: vscode.TreeItemCollapsibleState;
	public iconPath: vscode.Uri | undefined;
	public contextValue?: string;

	constructor(
		public parent: TreeNode | vscode.TreeView<TreeNode>,
		private readonly pullRequestManager: PullRequestManager,
		private readonly pullRequest: PullRequestModel,
		private readonly commit: Octokit.PullsListCommitsResponseItem,
		private readonly comments: IComment[]
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
		const fileChanges = await this.pullRequestManager.getCommitChangedFiles(this.pullRequest, this.commit);

		const fileChangeNodes = fileChanges.map(change => {
			const matchingComments = this.comments.filter(comment => comment.path === change.filename && comment.originalCommitId === this.commit.sha);
			const fileName = change.filename;
			const uri = vscode.Uri.parse(path.join(`commit~${this.commit.sha.substr(0, 8)}`, fileName));
			const fileChangeNode = new GitFileChangeNode(
				this,
				this.pullRequest,
				getGitChangeType(change.status),
				fileName,
				undefined,
				toReviewUri(uri, fileName, undefined, this.commit.sha, true, { base: false }),
				toReviewUri(uri, fileName, undefined, this.commit.sha, true, { base: true }),
				false,
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
