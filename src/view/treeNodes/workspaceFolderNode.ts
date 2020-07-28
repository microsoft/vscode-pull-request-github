/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'path';
import { PRType } from '../../github/interface';
import { TreeNode } from './treeNode';
import { FolderPullRequestManager } from '../../github/folderPullRequestManager';
import { ITelemetry } from '../../common/telemetry';
import { CategoryTreeNode } from './categoryNode';

export interface IQueryInfo {
	label: string;
	query: string;
}

export class WorkspaceFolderNode extends TreeNode implements vscode.TreeItem {
	public readonly label: string;
	public collapsibleState: vscode.TreeItemCollapsibleState;
	public iconPath?: { light: string | vscode.Uri; dark: string | vscode.Uri };

	constructor(parent: TreeNode | vscode.TreeView<TreeNode>, uri: vscode.Uri, private queries: IQueryInfo[], private folderManager: FolderPullRequestManager, private telemetry: ITelemetry) {
		super();
		this.parent = parent;
		this.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
		this.label = path.basename(uri.fsPath);
	}

	getTreeItem(): vscode.TreeItem {
		return this;
	}

	async getChildren(): Promise<TreeNode[]> {
		const queryCategories = this.queries.map(queryInfo => new CategoryTreeNode(this, this.folderManager, this.telemetry, PRType.Query, queryInfo.label, queryInfo.query));
		return [
			new CategoryTreeNode(this, this.folderManager, this.telemetry, PRType.LocalPullRequest),
			...queryCategories,
			new CategoryTreeNode(this, this.folderManager, this.telemetry, PRType.All)
		];
	}
}
