/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { DescriptionNode } from './descriptionNode';
import { FilesCategoryNode } from './filesCategoryNode';
import { CommitsNode } from './commitsCategoryNode';
import { TreeNode } from './treeNode';
import { PullRequestModel } from '../../github/pullRequestModel';
import { FolderRepositoryManager } from '../../github/folderRepositoryManager';
import { IComment } from '../../common/comment';
import { GitFileChangeNode, RemoteFileChangeNode } from './fileChangeNode';

export class RepositoryChangesNode extends DescriptionNode implements vscode.TreeItem {
	private _filesCategoryNode?: FilesCategoryNode;
	private _commitsCategoryNode?: CommitsNode;
	public label: string;
	readonly collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
	public contextValue?: string;

	private _disposables: vscode.Disposable[] = [];

	constructor(public parent: vscode.TreeView<TreeNode>,
		private _pullRequest: PullRequestModel,
		private _pullRequestManager: FolderRepositoryManager,
		private _comments: IComment[],
		private _localFileChanges: (GitFileChangeNode | RemoteFileChangeNode)[]) {
		super(parent, _pullRequest.title, _pullRequest.userAvatarUri!, _pullRequest);
		this.label = this._pullRequest.title;

		this._disposables.push(vscode.window.onDidChangeActiveTextEditor(e => {
			const activeEditorUri = e?.document.uri.toString();
			this.revealActiveEditorInTree(activeEditorUri);
		}));

		this._disposables.push(this.parent.onDidChangeVisibility(_ => {
			const activeEditorUri = vscode.window.activeTextEditor?.document.uri.toString();
			this.revealActiveEditorInTree(activeEditorUri);
		}));
	}

	private revealActiveEditorInTree(activeEditorUri: string | undefined): void {
		if (this.parent.visible && activeEditorUri) {
			const matchingFile = this._localFileChanges.find(change => change.filePath.toString() === activeEditorUri);
			if (matchingFile) {
				this.reveal(matchingFile, { select: true });
			}
		}
	}

	async getChildren(): Promise<TreeNode[]> {
		if (!this._filesCategoryNode || !this._commitsCategoryNode) {
			this._filesCategoryNode = new FilesCategoryNode(this.parent, this._localFileChanges);
			this._commitsCategoryNode = new CommitsNode(this.parent, this._pullRequestManager, this._pullRequest, this._comments);
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