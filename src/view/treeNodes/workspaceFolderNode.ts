/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { PR_SETTINGS_NAMESPACE, QUERIES } from '../../common/settingKeys';
import { ITelemetry } from '../../common/telemetry';
import { CopilotRemoteAgentManager } from '../../github/copilotRemoteAgent';
import { FolderRepositoryManager } from '../../github/folderRepositoryManager';
import { PRType } from '../../github/interface';
import { NotificationProvider } from '../../github/notifications';
import { PullRequestModel } from '../../github/pullRequestModel';
import { PrsTreeModel } from '../prsTreeModel';
import { CategoryTreeNode, isAllQuery, isLocalQuery } from './categoryNode';
import { TreeNode, TreeNodeParent } from './treeNode';

export interface IQueryInfo {
	label: string;
	query: string;
}

export class WorkspaceFolderNode extends TreeNode implements vscode.TreeItem {
	protected override _children: CategoryTreeNode[] | undefined = undefined;
	public collapsibleState: vscode.TreeItemCollapsibleState;
	public iconPath?: { light: vscode.Uri; dark: vscode.Uri };

	constructor(
		parent: TreeNodeParent,
		uri: vscode.Uri,
		public readonly folderManager: FolderRepositoryManager,
		private _telemetry,
		private _notificationProvider,
		private _context,
		private readonly _prsTreeModel: PrsTreeModel,
		private readonly _copilotMananger: CopilotRemoteAgentManager
	) {
		super(parent);
		this.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
		this.label = path.basename(uri.fsPath);
		this.id = folderManager.repository.rootUri.toString();
	}

	public async expandPullRequest(pullRequest: PullRequestModel): Promise<boolean> {
		if (this._children) {
			for (const child of this._children) {
				if (child.type === PRType.All) {
					return child.expandPullRequest(pullRequest);
				}
			}
		}
		return false;
	}

	private static async _getQueries(folderManager: FolderRepositoryManager): Promise<IQueryInfo[]> {
		const configuration = vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE, folderManager.repository.rootUri);
		const queries = (configuration.get<IQueryInfo[]>(QUERIES) ?? []);
		return queries;
	}

	getTreeItem(): vscode.TreeItem {
		return this;
	}

	override async getChildren(shouldDispose: boolean = true): Promise<TreeNode[]> {
		super.getChildren(shouldDispose);
		if (!shouldDispose && this._children) {
			return this._children;
		}
		this._children = await WorkspaceFolderNode.getCategoryTreeNodes(this.folderManager, this.telemetry, this, this.notificationProvider, this.context, this._prsTreeModel, this._copilotMananger);
		return this._children;
	}

	public static async getCategoryTreeNodes(
		folderManager: FolderRepositoryManager,
		telemetry: ITelemetry,
		parent: TreeNodeParent,
		notificationProvider: NotificationProvider,
		context: vscode.ExtensionContext,
		prsTreeModel: PrsTreeModel,
		copilotManager: CopilotRemoteAgentManager
	) {
		const queries = await WorkspaceFolderNode.getQueries(folderManager);
		const queryCategories: Map<string, CategoryTreeNode> = new Map();
		for (const queryInfo of queries) {
			if (isLocalQuery(queryInfo)) {
				queryCategories.set(queryInfo.label, new CategoryTreeNode(parent, folderManager, telemetry, PRType.LocalPullRequest, notificationProvider, prsTreeModel, copilotManager));
			} else if (isAllQuery(queryInfo)) {
				queryCategories.set(queryInfo.label, new CategoryTreeNode(parent, folderManager, telemetry, PRType.All, notificationProvider, prsTreeModel, copilotManager));
			} else {
				queryCategories.set(queryInfo.label, new CategoryTreeNode(parent, folderManager, telemetry, PRType.Query, notificationProvider, prsTreeModel, copilotManager, queryInfo.label, queryInfo.query));
			}
		}

		return Array.from(queryCategories.values());
	}
}
