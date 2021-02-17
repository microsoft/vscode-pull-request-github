/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { GitFileChangeNode, RemoteFileChangeNode } from './treeNodes/fileChangeNode';
import { TreeNode } from './treeNodes/treeNode';
import { IComment } from '../common/comment';
import { FolderRepositoryManager, SETTINGS_NAMESPACE } from '../github/folderRepositoryManager';
import { PullRequestModel } from '../github/pullRequestModel';
import { RepositoryChangesNode } from './treeNodes/repositoryChangesNode';
import { DescriptionNode } from './treeNodes/descriptionNode';

export class PullRequestChangesTreeDataProvider extends vscode.Disposable implements vscode.TreeDataProvider<TreeNode> {
	private _onDidChangeTreeData = new vscode.EventEmitter<void>();
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
			showCollapseAll: true
		});
		this._context.subscriptions.push(this._view);

		this._disposables.push(vscode.workspace.onDidChangeConfiguration(async e => {
			if (e.affectsConfiguration(`${SETTINGS_NAMESPACE}.fileListLayout`)) {
				this._onDidChangeTreeData.fire();
				const layout = vscode.workspace.getConfiguration(`${SETTINGS_NAMESPACE}`).get<string>('fileListLayout');
				await vscode.commands.executeCommand('setContext', 'fileListLayout:flat', layout === 'flat' ? true : false);
			} else if (e.affectsConfiguration('git.openDiffOnClick')) {
				this._onDidChangeTreeData.fire();
			}
		}));
	}

	refresh() {
		this._onDidChangeTreeData.fire();
	}

	private updateViewTitle(): void {
		let pullRequestNumber: number | undefined;
		if (this._pullRequestManagerMap.size === 1) {
			const pullRequestIterator = this._pullRequestManagerMap.values().next();
			if (!pullRequestIterator.done) {
				pullRequestNumber = pullRequestIterator.value.pullRequestModel.number;
			}
		}

		this._view.title = pullRequestNumber ? `Changes in Pull Request #${pullRequestNumber}` : 'Changes in Pull Request';
	}

	async addPrToView(pullRequestManager: FolderRepositoryManager, pullRequest: PullRequestModel, localFileChanges: (GitFileChangeNode | RemoteFileChangeNode)[], comments: IComment[], shouldReveal: boolean) {
		const node: RepositoryChangesNode = new RepositoryChangesNode(this._view, pullRequest, pullRequestManager, comments, localFileChanges);
		this._pullRequestManagerMap.set(pullRequestManager, node);
		this.updateViewTitle();

		await vscode.commands.executeCommand(
			'setContext',
			'github:inReviewMode',
			true
		);
		this._onDidChangeTreeData.fire();

		if (shouldReveal) {
			this._view.reveal(node);
		}
	}

	async removePrFromView(pullRequestManager: FolderRepositoryManager) {
		this._pullRequestManagerMap.delete(pullRequestManager);
		this.updateViewTitle();
		if (this._pullRequestManagerMap.size === 0) {
			this.hide();
		}
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