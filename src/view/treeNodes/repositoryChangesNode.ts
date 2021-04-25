/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { GitPullRequestCommentThread } from 'azure-devops-node-api/interfaces/GitInterfaces';
import * as vscode from 'vscode';
import { FolderRepositoryManager } from '../../azdo/folderRepositoryManager';
import { PullRequestModel } from '../../azdo/pullRequestModel';
import { CommitsNode } from './commitsCategoryNode';
import { DescriptionNode } from './descriptionNode';
import { GitFileChangeNode, RemoteFileChangeNode } from './fileChangeNode';
import { FilesCategoryNode } from './filesCategoryNode';
import { BaseTreeNode, TreeNode } from './treeNode';

export class RepositoryChangesNode extends DescriptionNode implements vscode.TreeItem {
	private _filesCategoryNode?: FilesCategoryNode;
	private _commitsCategoryNode?: CommitsNode;
	readonly collapsibleState = vscode.TreeItemCollapsibleState.Expanded;

	private _disposables: vscode.Disposable[] = [];

	constructor(
		public parent: BaseTreeNode,
		private _pullRequest: PullRequestModel,
		private _pullRequestManager: FolderRepositoryManager,
		private _comments: GitPullRequestCommentThread[],
		private _localFileChanges: (GitFileChangeNode | RemoteFileChangeNode)[],
	) {
		super(parent, _pullRequest.item.title ?? '', _pullRequest.item.createdBy!.imageUrl!, _pullRequest);
		this.label = this._pullRequest.item.title ?? '';

		this._disposables.push(
			vscode.window.onDidChangeActiveTextEditor(e => {
				const activeEditorUri = e?.document.uri.toString();
				this.revealActiveEditorInTree(activeEditorUri);
			}),
		);

		this._disposables.push(
			this.parent.view.onDidChangeVisibility(_ => {
				const activeEditorUri = vscode.window.activeTextEditor?.document.uri.toString();
				this.revealActiveEditorInTree(activeEditorUri);
			}),
		);
	}

	private revealActiveEditorInTree(activeEditorUri: string | undefined): void {
		if (this.parent.view.visible && activeEditorUri) {
			const matchingFile = this._localFileChanges.find(change => change.filePath.toString() === activeEditorUri);
			if (matchingFile) {
				this.reveal(matchingFile, { select: true });
			}
		}
	}

	async getChildren(): Promise<TreeNode[]> {
		if (!this._filesCategoryNode || !this._commitsCategoryNode) {
			this._filesCategoryNode = new FilesCategoryNode(this.parent, this._localFileChanges);
			this._commitsCategoryNode = new CommitsNode(
				this.parent,
				this._pullRequestManager,
				this._pullRequest,
				this._comments,
			);
		}
		return [this._filesCategoryNode, this._commitsCategoryNode];
	}

	getTreeItem(): vscode.TreeItem {
		return this;
	}

	dispose() {
		this._disposables.forEach(d => d.dispose());
		this._disposables = [];
	}
}
