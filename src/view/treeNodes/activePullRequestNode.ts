/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { TreeNode } from './treeNode';
// import { FilesCategoryNode } from './filesCategoryNode';
import { CommitsNode } from './commitsCategoryNode';
import { PullRequestManager } from '../../github/pullRequestManager';
import { DescriptionNode } from './descriptionNode';
import { Resource } from '../../common/resources';
import { Comment } from '../../common/comment';
import { GitFileChangeNode } from './fileChangeNode';

export class ActivePRNode extends TreeNode {
	private _pullRequestManager: PullRequestManager;
	private _isLocal: boolean;
	private _fileNodes: GitFileChangeNode[];

	constructor(parent: TreeNode, prManager: PullRequestManager, local: boolean) {
		super();
		this.parent = parent;
		this._pullRequestManager = prManager;
		this._isLocal = local;
		this._fileNodes = this._pullRequestManager.activeFileChanges!.map(change => new GitFileChangeNode(
			this,
			this._pullRequestManager.activePullRequest!,
			change.status, change.fileName, change.blobUrl, change.filePath,
			change.parentFilePath, change.isPartial, change.diffHunks, change.comments,
			change.sha));
		}

	getTreeItem(): vscode.TreeItem {
		const {
			title,
			prNumber,
			author,
			userAvatarUri
		} = this._pullRequestManager.activePullRequest!;

		const { login } = author;

		const formattedPRNumber = prNumber.toString();
		const label = `✓ ${title}`;
		const tooltip = `Current Branch * ${title} (#${formattedPRNumber}) by @${login}`;
		const description = `#${formattedPRNumber} by @${login}`;

		return {
			label,
			tooltip,
			description,
			collapsibleState: vscode.TreeItemCollapsibleState.Expanded,
			contextValue: 'pullrequest' + (this._isLocal ? ':local' : '') + ':active',
			iconPath: userAvatarUri
		};
	}

	async getChildren(): Promise<TreeNode[]> {
		return [
			new DescriptionNode(this, 'Description', {
				light: Resource.icons.light.Description,
				dark: Resource.icons.dark.Description
			}, this._pullRequestManager.activePullRequest!),
			// new FilesCategoryNode(this, this._fileNodes),
			...this._fileNodes,
			new CommitsNode(this, this._pullRequestManager, this._pullRequestManager.activePullRequest!, this._pullRequestManager.activeComments!)
		];
	}

	async revealComment(comment: Comment) {
		const fileChange = this._fileNodes.find(fc => {
			if (fc.fileName !== comment.path) {
				return false;
			}

			if (fc.pullRequest.head.sha !== comment.commitId) {
				return false;
			}

			return true;
		});

		if (fileChange) {
			await this.reveal(fileChange, { focus: true, expand: 2 });
			if (!fileChange.command.arguments) {
				return;
			}

			const lineNumber = fileChange.getCommentPosition(comment);
			const opts = fileChange.opts;
			opts.selection = new vscode.Range(lineNumber, 0, lineNumber, 0);
			fileChange.opts = opts;
			await vscode.commands.executeCommand(fileChange.command.command, fileChange);
		}
	}
}