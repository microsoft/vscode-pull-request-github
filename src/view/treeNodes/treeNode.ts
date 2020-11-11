/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

export interface Revealable<T> {
	reveal(element: T, options?: { select?: boolean, focus?: boolean, expand?: boolean | number }): Thenable<void>;
}

export abstract class TreeNode implements vscode.Disposable {
	childrenDisposables: vscode.Disposable[];
	parent: TreeNode | vscode.TreeView<TreeNode> | Revealable<TreeNode>;
	label?: string;

	constructor() { }
	abstract getTreeItem(): vscode.TreeItem;
	getParent(): TreeNode | undefined {
		if (this.parent instanceof TreeNode) {
			return this.parent;
		}
	}

	async reveal(treeNode: TreeNode, options?: { select?: boolean, focus?: boolean, expand?: boolean | number }): Promise<void> {
		return this.parent.reveal(treeNode || this, options);
	}

	async getChildren(): Promise<TreeNode[]> {
		return [];
	}

	dispose(): void {
		if (this.childrenDisposables) {
			this.childrenDisposables.forEach(dispose => dispose.dispose());
		}
	}
}