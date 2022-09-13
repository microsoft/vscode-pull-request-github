/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { ITelemetry } from '../../common/telemetry';
import { FolderRepositoryManager, SETTINGS_NAMESPACE } from '../../github/folderRepositoryManager';
import { PRType } from '../../github/interface';
import { NotificationProvider } from '../../github/notifications';
import { CategoryTreeNode } from './categoryNode';
import { TreeNode, TreeNodeParent } from './treeNode';

export interface IQueryInfo {
	label: string;
	query: string;
}

export const QUERIES_SETTING = 'queries';

export class WorkspaceFolderNode extends TreeNode implements vscode.TreeItem {
	public collapsibleState: vscode.TreeItemCollapsibleState;
	public iconPath?: { light: string | vscode.Uri; dark: string | vscode.Uri };

	constructor(
		parent: TreeNodeParent,
		uri: vscode.Uri,
		private folderManager: FolderRepositoryManager,
		private telemetry: ITelemetry,
		private notificationProvider: NotificationProvider,
	) {
		super();
		this.parent = parent;
		this.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
		this.label = path.basename(uri.fsPath);
	}

	private static getQueries(folderManager: FolderRepositoryManager): IQueryInfo[] {
		return (
			vscode.workspace
				.getConfiguration(SETTINGS_NAMESPACE, folderManager.repository.rootUri)
				.get<IQueryInfo[]>(QUERIES_SETTING) || []
		);
	}

	getTreeItem(): vscode.TreeItem {
		return this;
	}

	async getChildren(): Promise<TreeNode[]> {
		return WorkspaceFolderNode.getCategoryTreeNodes(this.folderManager, this.telemetry, this, this.notificationProvider);
	}

	public static getCategoryTreeNodes(
		folderManager: FolderRepositoryManager,
		telemetry: ITelemetry,
		parent: TreeNodeParent,
		notificationProvider: NotificationProvider,
	) {
		const queryCategories = WorkspaceFolderNode.getQueries(folderManager).map(
			queryInfo =>
				new CategoryTreeNode(parent, folderManager, telemetry, PRType.Query, notificationProvider, queryInfo.label, queryInfo.query),
		);
		return [
			new CategoryTreeNode(parent, folderManager, telemetry, PRType.LocalPullRequest, notificationProvider),
			...queryCategories,
			new CategoryTreeNode(parent, folderManager, telemetry, PRType.All, notificationProvider),
		];
	}
}
