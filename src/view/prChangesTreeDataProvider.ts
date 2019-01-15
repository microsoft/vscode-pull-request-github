/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { GitFileChangeNode, RemoteFileChangeNode } from './treeNodes/fileChangeNode';
import { DescriptionNode } from './treeNodes/descriptionNode';
import { TreeNode } from './treeNodes/treeNode';
import { FilesCategoryNode } from './treeNodes/filesCategoryNode';
import { CommitsNode } from './treeNodes/commitsCategoryNode';
import { Comment } from '../common/comment';
import { PullRequestManager } from '../github/pullRequestManager';
import { PullRequestModel } from '../github/pullRequestModel';

export class PullRequestChangesTreeDataProvider extends vscode.Disposable implements vscode.TreeDataProvider<TreeNode> {
	private _onDidChangeTreeData = new vscode.EventEmitter<GitFileChangeNode | DescriptionNode>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
	private _disposables: vscode.Disposable[] = [];

	private _localFileChanges: (GitFileChangeNode | RemoteFileChangeNode)[] = [];
	private _comments: Comment[] = [];
	private _pullrequest: PullRequestModel = null;
	private _pullRequestManager: PullRequestManager;
	private _view: vscode.TreeView<TreeNode>;

	public get view(): vscode.TreeView<TreeNode> {
		return this._view;
	}

	private _descriptionNode: DescriptionNode;
	private _filesCategoryNode: FilesCategoryNode;
	private _commitsCategoryNode: CommitsNode;

	constructor(private _context: vscode.ExtensionContext) {
		super(() => this.dispose());
		this._view = vscode.window.createTreeView('prStatus', {
			treeDataProvider: this,
			showCollapseAll: true
		});
		this._descriptionNode = null;
		this._filesCategoryNode = null;
		this._commitsCategoryNode = null;
		this._context.subscriptions.push(this._view);
	}

	refresh() {
		this._descriptionNode = null;
		this._filesCategoryNode = null;
		this._commitsCategoryNode = null;
		this._onDidChangeTreeData.fire();
	}

	async showPullRequestFileChanges(pullRequestManager: PullRequestManager, pullrequest: PullRequestModel, fileChanges: (GitFileChangeNode | RemoteFileChangeNode)[], comments: Comment[]) {
		this._pullRequestManager = pullRequestManager;
		this._pullrequest = pullrequest;
		this._comments = comments;

		await vscode.commands.executeCommand(
			'setContext',
			'github:inReviewMode',
			true
		);

		this._localFileChanges = fileChanges;
		this._descriptionNode = null;
		this._filesCategoryNode = null;
		this._commitsCategoryNode = null;
		this._onDidChangeTreeData.fire();
	}

	async hide() {
		await vscode.commands.executeCommand(
			'setContext',
			'github:inReviewMode',
			false
		);
	}

	getTreeItem(element: TreeNode): vscode.TreeItem | Thenable<vscode.TreeItem> {
		return element.getTreeItem();
	}

	getParent(element: TreeNode) {
		return element.getParent();
	}

	async reveal(element: TreeNode, options?: { select?: boolean, focus?: boolean, expand?: boolean | number }): Promise<void> {
		this._view.reveal(element, options);
	}

	async revealComment(comment: Comment) {
		let fileChange = this._localFileChanges.find(fc => {
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
			if (fileChange instanceof GitFileChangeNode) {
				let lineNumber = fileChange.getCommentPosition(comment);
				let [ parentFilePath, filePath, fileName, isPartial, opts ] = fileChange.command.arguments;
				opts.selection = new vscode.Range(lineNumber, 0, lineNumber, 0);
				await vscode.commands.executeCommand(fileChange.command.command, parentFilePath, filePath, fileName, isPartial, opts);
			} else {
				await vscode.commands.executeCommand(fileChange.command.command, ...fileChange.command.arguments);
			}
		}
	}

	async getChildren(element?: GitFileChangeNode): Promise<TreeNode[]> {
		if (!element) {
			if (!this._descriptionNode || !this._filesCategoryNode || !this._commitsCategoryNode) {
				this._descriptionNode = new DescriptionNode(this, this._pullrequest.title,
					this._pullrequest.userAvatarUri, this._pullrequest);
				this._filesCategoryNode = new FilesCategoryNode(this._view, this._localFileChanges);
				this._commitsCategoryNode = new CommitsNode(this._view, this._pullRequestManager, this._pullrequest, this._comments);
			}
			return [ this._descriptionNode, this._filesCategoryNode, this._commitsCategoryNode ];
		} else {
			return await element.getChildren();
		}
	}

	dispose() {
		this._disposables.forEach(disposable => disposable.dispose());
	}
}