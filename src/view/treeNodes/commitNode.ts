/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { getGitChangeType } from '../../common/diffHunk';
import { FILE_LIST_LAYOUT, PR_SETTINGS_NAMESPACE } from '../../common/settingKeys';
import { DataUri, reviewPath, toReviewUri } from '../../common/uri';
import { dateFromNow } from '../../common/utils';
import { OctokitCommon } from '../../github/common';
import { FolderRepositoryManager } from '../../github/folderRepositoryManager';
import { AccountType, IAccount } from '../../github/interface';
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
		parent: TreeNodeParent,
		private readonly _pullRequestManager,
		private readonly _pullRequest,
		private readonly _commit,
		private readonly _isCurrent
	) {
		super(parent);
		this.label = commit.commit.message;
		this.sha = commit.sha;
		this.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
		this.contextValue = 'commit';
		this.description = commit.commit.author?.date ? dateFromNow(commit.commit.author.date) : undefined;
	}

	async getTreeItem(): Promise<vscode.TreeItem> {
		if (this.commit.author) {
			const author: IAccount = { id: this.commit.author.node_id, login: this.commit.author.login, url: this.commit.author.url, avatarUrl: this.commit.author.avatar_url, accountType: this.commit.author.type as AccountType };
			this.iconPath = (await DataUri.avatarCirclesAsImageDataUris(this._pullRequestManager.context, [author], 16, 16))[0];
		}
		return this;
	}

	override async getChildren(): Promise<TreeNode[]> {
		super.getChildren();
		const fileChanges = (await this.pullRequest.getCommitChangedFiles(this.commit)) ?? [];

		if (fileChanges.length === 0) {
			return [new LabelOnlyNode(this, 'No changed files')];
		}

		const fileChangeNodes = fileChanges.map(change => {
			const fileName = change.filename!;
			const uri = reviewPath(fileName, this.commit.sha);
			const changeModel = new GitFileChangeModel(
				this._pullRequestManager,
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
					this._pullRequestManager.repository.rootUri,
				),
				toReviewUri(
					uri,
					fileName,
					undefined,
					this.commit.sha,
					true,
					{ base: true },
					this._pullRequestManager.repository.rootUri,
				),
				this.commit.sha);
			const fileChangeNode = new GitFileChangeNode(
				this,
				this._pullRequestManager,
				this.pullRequest as (PullRequestModel & IResolvedPullRequestModel),
				changeModel,
				this.isCurrent
			);

			fileChangeNode.useViewChangesCommand();

			return fileChangeNode;
		});

		let result: TreeNode[] = [];
		const layout = vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE).get<string>(FILE_LIST_LAYOUT);
		if (layout === 'tree') {
			// tree view
			const dirNode = new DirectoryTreeNode(this, '');
			fileChangeNodes.forEach(f => dirNode.addFile(f));
			dirNode.finalize();
			if (dirNode.label === '') {
				// nothing on the root changed, pull children to parent
				result.push(...dirNode._children);
			} else {
				result.push(dirNode);
			}
		} else {
			// flat view
			result = fileChangeNodes;
		}
		this._children = result;
		return result;
	}
}
