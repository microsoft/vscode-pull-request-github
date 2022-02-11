/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import Logger from '../common/logger';
import { FILE_LIST_LAYOUT } from '../common/settingKeys';
import { FolderRepositoryManager, SETTINGS_NAMESPACE } from '../github/folderRepositoryManager';
import { PullRequestModel } from '../github/pullRequestModel';
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

	constructor(private _context: vscode.ExtensionContext) {
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
			: 'Changes in Pull Request';
	}

	async addPrToView(
		pullRequestManager: FolderRepositoryManager,
		pullRequestModel: PullRequestModel,
		reviewModel: ReviewModel,
		shouldReveal: boolean,
	) {
		if (this._pullRequestManagerMap.has(pullRequestManager)) {
			const existingNode = this._pullRequestManagerMap.get(pullRequestManager);
			if (existingNode && (existingNode.pullRequestModel === pullRequestModel)) {
				return;
			} else {
				existingNode?.dispose();
			}
		}
		const node: RepositoryChangesNode = new RepositoryChangesNode(
			this,
			pullRequestModel,
			pullRequestManager,
			reviewModel
		);
		this._pullRequestManagerMap.set(pullRequestManager, node);
		this.updateViewTitle();

		await vscode.commands.executeCommand('setContext', 'github:inReviewMode', true);
		this._onDidChangeTreeData.fire();

		if (shouldReveal) {
			this.reveal(node);
		}
	}

	async removePrFromView(pullRequestManager: FolderRepositoryManager) {
		const oldPR = this._pullRequestManagerMap.has(pullRequestManager) ? this._pullRequestManagerMap.get(pullRequestManager) : undefined;
		oldPR?.dispose();
		this._pullRequestManagerMap.delete(pullRequestManager);
		this.updateViewTitle();
		if (this._pullRequestManagerMap.size === 0) {
			this.hide();
		}
		this._onDidChangeTreeData.fire();
	}

	async hide() {
		await vscode.commands.executeCommand('setContext', 'github:inReviewMode', false);
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
			Logger.appendLine(e, 'PullRequestChangesTreeDataProvider');
		}
	}

	async getChildren(element?: GitFileChangeNode): Promise<TreeNode[]> {
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
