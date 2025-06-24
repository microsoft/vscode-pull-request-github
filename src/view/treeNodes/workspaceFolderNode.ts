/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { PR_SETTINGS_NAMESPACE, QUERIES } from '../../common/settingKeys';
import { ITelemetry } from '../../common/telemetry';
import { CopilotStateModel } from '../../github/copilotPrWatcher';
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
	protected override children: CategoryTreeNode[] | undefined = undefined;
	public collapsibleState: vscode.TreeItemCollapsibleState;
	public iconPath?: { light: string | vscode.Uri; dark: string | vscode.Uri };

	constructor(
		parent: TreeNodeParent,
		uri: vscode.Uri,
		public readonly folderManager: FolderRepositoryManager,
		private telemetry: ITelemetry,
		private notificationProvider: NotificationProvider,
		private context: vscode.ExtensionContext,
		private readonly _prsTreeModel: PrsTreeModel,
		private readonly _copilotStateModel: CopilotStateModel
	) {
		super(parent);
		this.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
		this.label = path.basename(uri.fsPath);
		this.id = folderManager.repository.rootUri.toString();
	}

	public async expandPullRequest(pullRequest: PullRequestModel): Promise<boolean> {
		if (this.children) {
			for (const child of this.children) {
				if (child.type === PRType.All) {
					return child.expandPullRequest(pullRequest);
				}
			}
		}
		return false;
	}

	private static async getQueries(folderManager: FolderRepositoryManager): Promise<IQueryInfo[]> {
		const configuration = vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE, folderManager.repository.rootUri);
		const queries = (configuration.get<IQueryInfo[]>(QUERIES) ?? []);
		return queries;
	}

	getTreeItem(): vscode.TreeItem {
		return this;
	}

	override async getChildren(): Promise<TreeNode[]> {
		super.getChildren();
		this.children = await WorkspaceFolderNode.getCategoryTreeNodes(this.folderManager, this.telemetry, this, this.notificationProvider, this.context, this._prsTreeModel, this._copilotStateModel);
		return this.children;
	}

	public static async getCategoryTreeNodes(
		folderManager: FolderRepositoryManager,
		telemetry: ITelemetry,
		parent: TreeNodeParent,
		notificationProvider: NotificationProvider,
		context: vscode.ExtensionContext,
		prsTreeModel: PrsTreeModel,
		copilotStateModel: CopilotStateModel
	) {
		const queryCategories = (await WorkspaceFolderNode.getQueries(folderManager)).map(
			queryInfo => {
				if (isLocalQuery(queryInfo)) {
					return new CategoryTreeNode(parent, folderManager, telemetry, PRType.LocalPullRequest, notificationProvider, prsTreeModel, copilotStateModel);
				} else if (isAllQuery(queryInfo)) {
					return new CategoryTreeNode(parent, folderManager, telemetry, PRType.All, notificationProvider, prsTreeModel, copilotStateModel);
				}
				return new CategoryTreeNode(parent, folderManager, telemetry, PRType.Query, notificationProvider, prsTreeModel, copilotStateModel, queryInfo.label, queryInfo.query);
			}
		);
		return queryCategories;
	}
}
