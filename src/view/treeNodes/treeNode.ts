/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

export interface BaseTreeNode {
	reveal(element: TreeNode, options?: { select?: boolean; focus?: boolean; expand?: boolean | number }): Thenable<void>;
	refresh(treeNode?: TreeNode): void;
	view: vscode.TreeView<TreeNode>;
}

export type TreeNodeParent = TreeNode | BaseTreeNode;

export abstract class TreeNode implements vscode.Disposable {
	childrenDisposables: vscode.Disposable[];
	parent: TreeNodeParent;
	label?: string;

	constructor() {}
	abstract getTreeItem(): vscode.TreeItem;
	getParent(): TreeNode | undefined {
		if (this.parent instanceof TreeNode) {
			return this.parent;
		}
	}

	async reveal(
		treeNode: TreeNode,
		options?: { select?: boolean; focus?: boolean; expand?: boolean | number },
	): Promise<void> {
		return this.parent.reveal(treeNode || this, options);
	}

	async getChildren(): Promise<TreeNode[]> {
		return [];
	}

	refresh(treeNode?: TreeNode): void {
		return this.parent.refresh(treeNode);
	}

	dispose(): void {
		if (this.childrenDisposables) {
			this.childrenDisposables.forEach(dispose => dispose.dispose());
		}
	}
}
