/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Repository } from '../../api/api';
import { FolderRepositoryManager } from '../../github/folderRepositoryManager';
import { PullRequestModel } from '../../github/pullRequestModel';
import { TreeNode, TreeNodeParent } from './treeNode';

export class DescriptionNode extends TreeNode implements vscode.TreeItem {
	public command?: vscode.Command;
	public contextValue?: string;
	public tooltip: string;
	public iconPath: vscode.ThemeIcon | vscode.Uri | undefined;

	constructor(
		public parent: TreeNodeParent,
		public label: string,
		public pullRequestModel: PullRequestModel,
		public readonly repository: Repository,
		private readonly folderRepositoryManager: FolderRepositoryManager
	) {
		super();

		this.command = {
			title: vscode.l10n.t('View Pull Request Description'),
			command: 'pr.openDescription',
			arguments: [this],
		};
		this.iconPath = new vscode.ThemeIcon('git-pull-request');
		this.tooltip = vscode.l10n.t('Description of pull request #{0}', pullRequestModel.number);
		this.accessibilityInformation = { label: vscode.l10n.t('Pull request page of pull request number {0}', pullRequestModel.number), role: 'button' };
	}

	async getTreeItem(): Promise<vscode.TreeItem> {
		this.updateContextValue();
		return this;
	}

	protected updateContextValue(): void {
		const currentBranchIsForThisPR = this.pullRequestModel.equals(this.folderRepositoryManager.activePullRequest);
		this.contextValue = 'description' +
			(currentBranchIsForThisPR ? ':active' : ':nonactive') +
			(this.pullRequestModel.hasChangesSinceLastReview ? ':hasChangesSinceReview' : '') +
			(this.pullRequestModel.showChangesSinceReview ? ':showingChangesSinceReview' : ':showingAllChanges');
	}
}
