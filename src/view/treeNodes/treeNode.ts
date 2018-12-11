/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Comment } from '../../common/comment';

export abstract class TreeNode implements vscode.Disposable {
	childrenDisposables: vscode.Disposable[];
	parent: TreeNode | vscode.TreeView<TreeNode>;

	constructor() { }
	abstract getTreeItem(): vscode.TreeItem;
	getParent(): TreeNode {
		if (this.parent instanceof TreeNode) {
			return this.parent;
		}

		return null;
	}

	async reveal(treeNode: TreeNode, options?: { select?: boolean, focus?: boolean, expand?: boolean | number }) {
		return this.parent.reveal(treeNode || this);
	}

	async revealComment?(comment: Comment) { }

	async getChildren(): Promise<TreeNode[]> {
		return [];
	}

	dispose(): void {
		if (this.childrenDisposables && this.childrenDisposables) {
			this.childrenDisposables.forEach(dispose => dispose.dispose());
		}
	}
}