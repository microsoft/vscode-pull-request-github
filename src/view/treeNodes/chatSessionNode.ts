/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ChatSessionWithPR } from '../../github/copilotApi';
import { TreeNode, TreeNodeParent } from './treeNode';

export class ChatSessionNode extends TreeNode {
	public readonly contextValue = 'chatSession';

	constructor(
		public readonly session: ChatSessionWithPR,
		parent: TreeNodeParent,
	) {
		super(parent);
		this.label = session.label;
	}

	override getTreeItem(): vscode.TreeItem {
		return {
			label: this.label,
			collapsibleState: vscode.TreeItemCollapsibleState.None,
			iconPath: this.session.iconPath,
			contextValue: this.contextValue,
		};
	}

	override async getChildren(): Promise<TreeNode[]> {
		return [];
	}
}
