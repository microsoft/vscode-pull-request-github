/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'path';
import { PRType } from '../../github/interface';
import { TreeNode } from './treeNode';
import { FolderPullRequestManager, SETTINGS_NAMESPACE } from '../../github/folderPullRequestManager';
import { ITelemetry } from '../../common/telemetry';
import { CategoryTreeNode } from './categoryNode';

export interface IQueryInfo {
	label: string;
	query: string;
}

export const QUERIES_SETTING = 'queries';

export class WorkspaceFolderNode extends TreeNode implements vscode.TreeItem {
	public readonly label: string;
	public collapsibleState: vscode.TreeItemCollapsibleState;
	public iconPath?: { light: string | vscode.Uri; dark: string | vscode.Uri };

	constructor(parent: TreeNode | vscode.TreeView<TreeNode>, uri: vscode.Uri, private folderManager: FolderPullRequestManager, private telemetry: ITelemetry, private isVso: boolean) {
		super();
		this.parent = parent;
		this.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
		this.label = path.basename(uri.fsPath);
	}

	private static getQueries(folderManager: FolderPullRequestManager, isVso: boolean): IQueryInfo[] {
		return isVso
			? []
			: vscode.workspace.getConfiguration(SETTINGS_NAMESPACE, folderManager.repository.rootUri).get<IQueryInfo[]>(QUERIES_SETTING) || [];
	}

	getTreeItem(): vscode.TreeItem {
		return this;
	}

	async getChildren(): Promise<TreeNode[]> {
		return WorkspaceFolderNode.getCategoryTreeNodes(this.folderManager, this.telemetry, this.isVso, this);
	}

	public static getCategoryTreeNodes(folderManager: FolderPullRequestManager, telemetry: ITelemetry, isVso: boolean, parent: TreeNode | vscode.TreeView<TreeNode>) {
		const queryCategories = WorkspaceFolderNode.getQueries(folderManager, isVso).map(queryInfo => new CategoryTreeNode(parent, folderManager, telemetry, PRType.Query, queryInfo.label, queryInfo.query));
		return [
			new CategoryTreeNode(parent, folderManager, telemetry, PRType.LocalPullRequest),
			...queryCategories,
			new CategoryTreeNode(parent, folderManager, telemetry, PRType.All)
		];
	}
}
