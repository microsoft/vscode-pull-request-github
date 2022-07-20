/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Repository } from '../../api/api';
import { fromPRUri, Schemes } from '../../common/uri';
import { FolderRepositoryManager } from '../../github/folderRepositoryManager';
import { PullRequestModel } from '../../github/pullRequestModel';
import { PRNode } from './pullRequestNode';
import { TreeNode, TreeNodeParent } from './treeNode';

export class DescriptionNode extends TreeNode implements vscode.TreeItem {
	public command?: vscode.Command;
	public contextValue?: string;
	public tooltip: string;

	public childrenDisposables: vscode.Disposable[] = [];

	constructor(
		public parent: TreeNodeParent,
		public label: string,
		public iconPath:
			| string
			| vscode.Uri
			| { light: string | vscode.Uri; dark: string | vscode.Uri }
			| vscode.ThemeIcon,
		public pullRequestModel: PullRequestModel,
		public readonly repository: Repository,
		public _folderReposManager: FolderRepositoryManager
	) {
		super();

		this.command = {
			title: 'View Pull Request Description',
			command: 'pr.openDescription',
			arguments: [this],
		};

		this.registerSinceReviewChange();

		this.tooltip = `Description of pull request #${pullRequestModel.number}`;
		this.accessibilityInformation = { label: `Pull request page of pull request number ${pullRequestModel.number}`, role: 'button' };
	}

	getTreeItem(): vscode.TreeItem {
		return this;
	}

	updateContextValue(): void {
		this.contextValue = 'description' +
			(this.pullRequestModel.hasChangesSinceLastReview ? ':changesSinceReview' : '') +
			(this.pullRequestModel.showChangesSinceReview ? ':active' : ':inactive');
	}

	protected registerSinceReviewChange() {
		this.childrenDisposables.push(
			this.pullRequestModel.onDidChangeChangesSinceReview(async data => {
				const { openFirst } = data;
				this.updateContextValue();
				this.refresh();
				await this.reopenNewPrDiffs(this.pullRequestModel);
				if (openFirst) {
					PullRequestModel.openFirstDiff(this._folderReposManager, this.pullRequestModel);
				}
			})
		);
	}

	public async reopenNewPrDiffs(pullRequest: PullRequestModel) {
		const proms = vscode.window.tabGroups.all.map(tabGroup => {
			return tabGroup.tabs.map(tab => {
				Promise.resolve(this.reopenTab(tab, pullRequest));
			});
		}).flat();

		await Promise.all(proms);
	}

	public async reopenTab(tab: vscode.Tab, pullRequest: PullRequestModel) {
		if (tab.input instanceof vscode.TabInputTextDiff) {
			if ((tab.input.original.scheme === Schemes.Pr) && (tab.input.modified.scheme === Schemes.Pr)) {
				const changes = await (this.parent as PRNode).getFileChanges(true); // HERE THE 'UGLY' WORKAROUND
				for (const localChange of changes) {

					const originalParams = fromPRUri(tab.input.original);
					const modifiedParams = fromPRUri(tab.input.modified);
					if ((originalParams?.prNumber === pullRequest.number) && (modifiedParams?.prNumber === pullRequest.number)) {
						if (localChange.fileName === modifiedParams.fileName) {
							vscode.window.tabGroups.close(tab).then(_ => localChange.openDiff(this._folderReposManager, { preview: tab.isPreview }));
							break;
						}
					}

				}
			}
		}
	}
}
