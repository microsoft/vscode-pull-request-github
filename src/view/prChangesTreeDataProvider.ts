/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { GitApiImpl } from '../api/api1';
import { commands, contexts } from '../common/executeCommands';
import Logger, { PR_TREE } from '../common/logger';
import { FILE_LIST_LAYOUT } from '../common/settingKeys';
import { FolderRepositoryManager, SETTINGS_NAMESPACE } from '../github/folderRepositoryManager';
import { PullRequestModel } from '../github/pullRequestModel';
import { RepositoriesManager } from '../github/repositoriesManager';
import { ProgressHelper } from './progress';
import { ReviewModel } from './reviewModel';
import { DescriptionNode } from './treeNodes/descriptionNode';
import { GitFileChangeNode } from './treeNodes/fileChangeNode';
import { RepositoryChangesNode } from './treeNodes/repositoryChangesNode';
import { BaseTreeNode, TreeNode } from './treeNodes/treeNode';

export class PullRequestChangesTreeDataProvider extends vscode.Disposable implements vscode.TreeDataProvider<TreeNode>, BaseTreeNode {
	private _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
	private _disposables: vscode.Disposable[] = [];

	private _pullRequestManagerMap: Map<FolderRepositoryManager, RepositoryChangesNode> = new Map();
	private _view: vscode.TreeView<TreeNode>;

	public get view(): vscode.TreeView<TreeNode> {
		return this._view;
	}

	constructor(private _context: vscode.ExtensionContext, private _git: GitApiImpl, private _reposManager: RepositoriesManager) {
		super(() => this.dispose());
		this._view = vscode.window.createTreeView('prStatus:github', {
			treeDataProvider: this,
			showCollapseAll: true,
		});
		this._context.subscriptions.push(this._view);

		this._disposables.push(
			vscode.workspace.onDidChangeConfiguration(async e => {
				if (e.affectsConfiguration(`${SETTINGS_NAMESPACE}.${FILE_LIST_LAYOUT}`)) {
					this._onDidChangeTreeData.fire();
					const layout = vscode.workspace
						.getConfiguration(`${SETTINGS_NAMESPACE}`)
						.get<string>(FILE_LIST_LAYOUT);
					await vscode.commands.executeCommand('setContext', 'fileListLayout:flat', layout === 'flat');
				} else if (e.affectsConfiguration('git.openDiffOnClick')) {
					this._onDidChangeTreeData.fire();
				}
			}),
		);

		this._disposables.push(this._view.onDidChangeCheckboxState(checkboxUpdates => {
			checkboxUpdates.items.forEach(checkboxUpdate => {
				const node = checkboxUpdate[0];
				const newState = checkboxUpdate[1];
				node.updateCheckbox(newState);
			});
		}));
	}

	refresh(treeNode?: TreeNode) {
		this._onDidChangeTreeData.fire(treeNode);
	}

	private updateViewTitle(): void {
		let pullRequestNumber: number | undefined;
		if (this._pullRequestManagerMap.size === 1) {
			const pullRequestIterator = this._pullRequestManagerMap.values().next();
			if (!pullRequestIterator.done) {
				pullRequestNumber = pullRequestIterator.value.pullRequestModel.number;
			}
		}

		this._view.title = pullRequestNumber
			? `Changes in Pull Request #${pullRequestNumber}`
			: (this._pullRequestManagerMap.size > 1 ? 'Changes in Pull Requests' : 'Changes in Pull Request');
	}

	async addPrToView(
		pullRequestManager: FolderRepositoryManager,
		pullRequestModel: PullRequestModel,
		reviewModel: ReviewModel,
		shouldReveal: boolean,
		progress: ProgressHelper
	) {
		Logger.appendLine(`Adding PR #${pullRequestModel.number} to tree`, PR_TREE);
		if (this._pullRequestManagerMap.has(pullRequestManager)) {
			const existingNode = this._pullRequestManagerMap.get(pullRequestManager);
			if (existingNode && (existingNode.pullRequestModel === pullRequestModel)) {
				Logger.appendLine(`PR #${pullRequestModel.number} already exists in tree`, PR_TREE);
				return;
			} else {
				existingNode?.dispose();
			}
		}
		const node: RepositoryChangesNode = new RepositoryChangesNode(
			this,
			pullRequestModel,
			pullRequestManager,
			reviewModel,
			progress
		);
		this._pullRequestManagerMap.set(pullRequestManager, node);
		this.updateViewTitle();

		await this.setReviewModeContexts();
		this._onDidChangeTreeData.fire();

		if (shouldReveal) {
			this.reveal(node);
		}
	}

	private async setReviewModeContexts() {
		await commands.setContext(contexts.IN_REVIEW_MODE, this._pullRequestManagerMap.size > 0);

		const rootUrisNotInReviewMode: string[] = [];
		const rootUrisInReviewMode: string[] = [];
		this._git.repositories.forEach(repo => {
			const folderManager = this._reposManager.getManagerForFile(repo.rootUri);
			if (folderManager && !this._pullRequestManagerMap.has(folderManager)) {
				rootUrisNotInReviewMode.push(repo.rootUri.toString());
			} else if (folderManager) {
				rootUrisInReviewMode.push(repo.rootUri.toString());
			}
		});
		await commands.setContext(contexts.REPOS_NOT_IN_REVIEW_MODE, rootUrisNotInReviewMode);
		await commands.setContext(contexts.REPOS_IN_REVIEW_MODE, rootUrisInReviewMode);
	}

	async removePrFromView(pullRequestManager: FolderRepositoryManager) {
		const oldPR = this._pullRequestManagerMap.has(pullRequestManager) ? this._pullRequestManagerMap.get(pullRequestManager) : undefined;
		Logger.appendLine(`Removing PR #${oldPR?.pullRequestModel.number} from tree`, PR_TREE);

		oldPR?.dispose();
		this._pullRequestManagerMap.delete(pullRequestManager);
		this.updateViewTitle();

		await this.setReviewModeContexts();
		this._onDidChangeTreeData.fire();
	}

	getTreeItem(element: TreeNode): vscode.TreeItem | Thenable<vscode.TreeItem> {
		return element.getTreeItem();
	}

	getParent(element: TreeNode) {
		return element.getParent();
	}

	async reveal(
		element: TreeNode,
		options?: { select?: boolean; focus?: boolean; expand?: boolean | number },
	): Promise<void> {
		try {
			await this._view.reveal(element, options);
		} catch (e) {
			Logger.error(e, PR_TREE);
		}
	}

	async getChildren(element?: TreeNode): Promise<TreeNode[]> {
		if (!element) {
			const result: TreeNode[] = [];
			if (this._pullRequestManagerMap.size >= 1) {
				for (const item of this._pullRequestManagerMap.values()) {
					result.push(item);
				}
			}
			return result;
		} else {
			return await element.getChildren();
		}
	}

	getDescriptionNode(folderRepoManager: FolderRepositoryManager): DescriptionNode | undefined {
		return this._pullRequestManagerMap.get(folderRepoManager);
	}

	async resolveTreeItem?(item: vscode.TreeItem, element: TreeNode): Promise<vscode.TreeItem> {
		if (element instanceof GitFileChangeNode) {
			await element.resolve();
		}
		return element;
	}

	dispose() {
		this._disposables.forEach(disposable => disposable.dispose());
	}
}
