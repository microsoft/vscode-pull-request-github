/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { FolderRepositoryManager } from '../../azdo/folderRepositoryManager';
import { PRType } from '../../azdo/interface';
import { ITelemetry } from '../../common/telemetry';
import { CategoryTreeNode } from './categoryNode';
import { TreeNode, TreeNodeParent } from './treeNode';

export interface IQueryInfo {
	label: string;
	query: string;
}

export class WorkspaceFolderNode extends TreeNode implements vscode.TreeItem {
	public collapsibleState: vscode.TreeItemCollapsibleState;
	public iconPath?: { light: string | vscode.Uri; dark: string | vscode.Uri };

	constructor(
		parent: TreeNodeParent,
		uri: vscode.Uri,
		private folderManager: FolderRepositoryManager,
		private telemetry: ITelemetry,
	) {
		super();
		this.parent = parent;
		this.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
		this.label = path.basename(uri.fsPath);
	}

	getTreeItem(): vscode.TreeItem {
		return this;
	}

	async getChildren(): Promise<TreeNode[]> {
		return WorkspaceFolderNode.getCategoryTreeNodes(this.folderManager, this.telemetry, this);
	}

	public static getCategoryTreeNodes(folderManager: FolderRepositoryManager, telemetry: ITelemetry, parent: TreeNodeParent) {
		return [
			new CategoryTreeNode(parent, folderManager, telemetry, PRType.LocalPullRequest),
			new CategoryTreeNode(parent, folderManager, telemetry, PRType.CreatedByMe),
			new CategoryTreeNode(parent, folderManager, telemetry, PRType.AssignedToMe),
			new CategoryTreeNode(parent, folderManager, telemetry, PRType.AllActive),
		];
	}
}
