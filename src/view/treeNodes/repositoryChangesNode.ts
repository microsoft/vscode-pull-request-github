/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Repository } from '../../api/api';
import Logger, { PR_TREE } from '../../common/logger';
import { AUTO_REVEAL, EXPLORER } from '../../common/settingKeys';
import { DataUri, Schemes } from '../../common/uri';
import { FolderRepositoryManager } from '../../github/folderRepositoryManager';
import { PullRequestModel } from '../../github/pullRequestModel';
import { ProgressHelper } from '../progress';
import { ReviewModel } from '../reviewModel';
import { CommitsNode } from './commitsCategoryNode';
import { FilesCategoryNode } from './filesCategoryNode';
import { BaseTreeNode, TreeNode } from './treeNode';

export class RepositoryChangesNode extends TreeNode implements vscode.TreeItem {
	private _filesCategoryNode?: FilesCategoryNode;
	private _commitsCategoryNode?: CommitsNode;
	public command?: vscode.Command;
	public contextValue?: string;
	public tooltip: string;
	public iconPath: vscode.ThemeIcon | vscode.Uri | undefined;
	readonly collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
	private isLocal: boolean;
	public readonly repository: Repository;

	constructor(
		public override parent: BaseTreeNode,
		public readonly pullRequestModel: PullRequestModel,
		private _pullRequestManager: FolderRepositoryManager,
		private _reviewModel: ReviewModel,
		private _progress: ProgressHelper
	) {
		super(parent);
		this.isLocal = true;
		this.repository = _pullRequestManager.repository;
		this.label = pullRequestModel.title;

		this.command = {
			title: vscode.l10n.t('View Pull Request Description'),
			command: 'pr.openDescription',
			arguments: [this],
		};
		this.tooltip = vscode.l10n.t('Description of pull request #{0}', pullRequestModel.number);
		this.accessibilityInformation = { label: vscode.l10n.t('Pull request page of pull request number {0}', pullRequestModel.number), role: 'button' };

		// Cause tree values to be filled
		this.getTreeItem();

		this._register(vscode.window.onDidChangeActiveTextEditor(e => {
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
		}));

		this._register(this.parent.view.onDidChangeVisibility(_ => {
			const activeEditorUri = vscode.window.activeTextEditor?.document.uri.toString();
			this.revealActiveEditorInTree(activeEditorUri);
		}));

		this._register(this.pullRequestModel.onDidChange(e => {
			if (e.title || e.state) {
				this.refresh();
			}
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

	override async getChildren(): Promise<TreeNode[]> {
		await this._progress.progress;
		if (!this._filesCategoryNode || !this._commitsCategoryNode) {
			Logger.appendLine(`Creating file and commit nodes for PR #${this.pullRequestModel.number}`, PR_TREE);
			this._filesCategoryNode = new FilesCategoryNode(this.parent, this._reviewModel, this.pullRequestModel);
			this._commitsCategoryNode = new CommitsNode(
				this.parent,
				this._pullRequestManager,
				this.pullRequestModel,
			);
		}
		this._children = [this._filesCategoryNode, this._commitsCategoryNode];
		return this._children;
	}

	private setLabel() {
		this.label = this.pullRequestModel.title;
		if (this.label.length > 50) {
			this.tooltip = this.label;
			this.label = `${this.label.substring(0, 50)}...`;
		}
	}

	override async getTreeItem(): Promise<vscode.TreeItem> {
		this.setLabel();
		this.iconPath = (await DataUri.avatarCirclesAsImageDataUris(this._pullRequestManager.context, [this.pullRequestModel.author], 16, 16))[0];
		this.description = undefined;
		if (this.parent.children?.length && this.parent.children.length > 1) {
			const allSameOwner = this.parent.children.every(child => {
				return child instanceof RepositoryChangesNode && child.pullRequestModel.remote.owner === this.pullRequestModel.remote.owner;
			});
			if (allSameOwner) {
				this.description = this.pullRequestModel.remote.repositoryName;
			} else {
				this.description = `${this.pullRequestModel.remote.owner}/${this.pullRequestModel.remote.repositoryName}`;
			}
		}
		this.updateContextValue();
		return this;
	}

	protected updateContextValue(): void {
		const currentBranchIsForThisPR = this.pullRequestModel.equals(this._pullRequestManager.activePullRequest);
		this.contextValue = 'description' +
			(currentBranchIsForThisPR ? ':active' : ':nonactive') +
			(this.pullRequestModel.hasChangesSinceLastReview ? ':hasChangesSinceReview' : '') +
			(this.pullRequestModel.showChangesSinceReview ? ':showingChangesSinceReview' : ':showingAllChanges') +
			(((this.pullRequestModel.item.isRemoteHeadDeleted && !this.isLocal) || !this._pullRequestManager.isPullRequestAssociatedWithOpenRepository(this.pullRequestModel)) ? '' : ':hasHeadRef');
	}
}
