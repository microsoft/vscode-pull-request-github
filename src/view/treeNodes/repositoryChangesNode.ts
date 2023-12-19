/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import Logger, { PR_TREE } from '../../common/logger';
import { AUTO_REVEAL, EXPLORER } from '../../common/settingKeys';
import { DataUri, Schemes } from '../../common/uri';
import { FolderRepositoryManager } from '../../github/folderRepositoryManager';
import { PullRequestModel } from '../../github/pullRequestModel';
import { ProgressHelper } from '../progress';
import { ReviewModel } from '../reviewModel';
import { CommitsNode } from './commitsCategoryNode';
import { DescriptionNode } from './descriptionNode';
import { FilesCategoryNode } from './filesCategoryNode';
import { BaseTreeNode, TreeNode } from './treeNode';

export class RepositoryChangesNode extends DescriptionNode implements vscode.TreeItem {
	private _filesCategoryNode?: FilesCategoryNode;
	private _commitsCategoryNode?: CommitsNode;
	public description?: string;
	readonly collapsibleState = vscode.TreeItemCollapsibleState.Expanded;

	private _disposables: vscode.Disposable[] = [];

	constructor(
		public parent: BaseTreeNode,
		private _pullRequest: PullRequestModel,
		private _pullRequestManager: FolderRepositoryManager,
		private _reviewModel: ReviewModel,
		private _progress: ProgressHelper
	) {
		super(parent, _pullRequest.title, _pullRequest, _pullRequestManager.repository, _pullRequestManager);
		// Cause tree values to be filled
		this.getTreeItem();

		this._disposables.push(
			vscode.window.onDidChangeActiveTextEditor(e => {
				if (vscode.workspace.getConfiguration(EXPLORER).get(AUTO_REVEAL)) {
					const tabInput = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
					if (tabInput instanceof vscode.TabInputTextDiff) {
						if ((tabInput.original.scheme === Schemes.Review)
							&& (tabInput.modified.scheme !== Schemes.Review)
							&& (tabInput.original.path.startsWith('/commit'))) {
							return;
						}
					}
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
		await this._progress.progress;
		if (!this._filesCategoryNode || !this._commitsCategoryNode) {
			Logger.appendLine(`Creating file and commit nodes for PR #${this.pullRequestModel.number}`, PR_TREE);
			this._filesCategoryNode = new FilesCategoryNode(this.parent, this._reviewModel, this._pullRequest);
			this._commitsCategoryNode = new CommitsNode(
				this.parent,
				this._pullRequestManager,
				this._pullRequest,
			);
		}
		this.children = [this._filesCategoryNode, this._commitsCategoryNode];
		return this.children;
	}

	async getTreeItem(): Promise<vscode.TreeItem> {
		this.label = this._pullRequest.title;
		this.iconPath = (await DataUri.avatarCirclesAsImageDataUris(this._pullRequestManager.context, [this._pullRequest.author], 16, 16))[0];
		this.description = undefined;
		if (this.parent.children?.length && this.parent.children.length > 1) {
			const allSameOwner = this.parent.children.every(child => {
				return child instanceof RepositoryChangesNode && child.pullRequestModel.remote.owner === this.pullRequestModel.remote.owner;
			});
			if (allSameOwner) {
				this.description = this._pullRequest.remote.repositoryName;
			} else {
				this.description = `${this._pullRequest.remote.owner}/${this._pullRequest.remote.repositoryName}`;
			}
			if (this.label.length > 35) {
				this.tooltip = this.label;
				this.label = `${this.label.substring(0, 35)}...`;
			}
		}
		this.updateContextValue();
		return this;
	}

	dispose() {
		super.dispose();
		this._disposables.forEach(d => d.dispose());
		this._disposables = [];
	}
}
