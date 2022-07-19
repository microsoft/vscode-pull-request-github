/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import Logger, { PR_TREE } from '../../common/logger';
import { fromReviewUri, Schemes } from '../../common/uri';
import { FolderRepositoryManager } from '../../github/folderRepositoryManager';
import { PullRequestModel } from '../../github/pullRequestModel';
import { ReviewModel } from '../reviewModel';
import { CommitsNode } from './commitsCategoryNode';
import { DescriptionNode } from './descriptionNode';
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
		private _reviewModel: ReviewModel
	) {
		super(parent, _pullRequest.title, _pullRequest.userAvatarUri!, _pullRequest);
		// Cause tree values to be filled
		this.getTreeItem();

		this._disposables.push(
			vscode.window.onDidChangeActiveTextEditor(e => {
				if (vscode.workspace.getConfiguration('explorer').get('autoReveal')) {
					const activeEditorUri = e?.document.uri.toString();
					this.revealActiveEditorInTree(activeEditorUri);
				}
			}),
		);

		this._disposables.push(
			this.parent.view.onDidChangeVisibility(_ => {
				const activeEditorUri = vscode.window.activeTextEditor?.document.uri.toString();
				this.revealActiveEditorInTree(activeEditorUri);
			}),
		);

		this._disposables.push(_pullRequest.onDidInvalidate(() => {
			this.refresh();
		}));
	}

	private revealActiveEditorInTree(activeEditorUri: string | undefined): void {
		if (this.parent.view.visible && activeEditorUri) {
			const matchingFile = this._reviewModel.localFileChanges.find(change => change.changeModel.filePath.toString() === activeEditorUri);
			if (matchingFile) {
				this.reveal(matchingFile, { select: true });
			}
		}
	}

	async getChildren(): Promise<TreeNode[]> {
		if (!this._filesCategoryNode || !this._commitsCategoryNode) {
			Logger.appendLine(`Creating file and commit nodes for PR #${this.pullRequestModel.number}`, PR_TREE);
			this._filesCategoryNode = new FilesCategoryNode(this.parent, this._reviewModel, this._pullRequest);
			this._commitsCategoryNode = new CommitsNode(
				this.parent,
				this._pullRequestManager,
				this._pullRequest,
			);
		}
		return [this._filesCategoryNode, this._commitsCategoryNode];
	}

	getTreeItem(): vscode.TreeItem {
		this.label = this._pullRequest.title;
		return this;
	}

	protected registerSinceReviewChange() {
		this.pullRequestModel.onDidChangeChangesSinceReview(_ => {
			this.updateContextValue();
			vscode.commands.executeCommand('pr.refreshChanges').then(() => {
				this.reopenNewDiffs();
			});
		});
	}

	public async reopenNewDiffs() {
		const reOpenFiles: { tabInput: vscode.TabInputTextDiff, isPreview: boolean }[] = [];

		await Promise.all(vscode.window.tabGroups.all.map(tabGroup => {
			return tabGroup.tabs.map(tab => {
				if (tab.input instanceof vscode.TabInputTextDiff) {
					if ((tab.input.original.scheme === Schemes.Review)) {
						reOpenFiles.push({ tabInput: tab.input, isPreview: tab.isPreview });
						return vscode.window.tabGroups.close(tab);
					}
				}
				return Promise.resolve(undefined);
			});
		}).flat());

		if (reOpenFiles.length) {
			for (const localChange of this._reviewModel.localFileChanges) {
				for (const { tabInput, isPreview } of reOpenFiles) {
					const fileName = fromReviewUri(tabInput.original.query);
					if (localChange.fileName === fileName.path) {
						localChange.openDiff(this._pullRequestManager, { preview: isPreview });
						break;
					}
				}
			}
		}
	}

	dispose() {
		super.dispose();
		this._disposables.forEach(d => d.dispose());
		this._disposables = [];
	}
}
