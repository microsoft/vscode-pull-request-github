/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Disposable, disposeAll } from '../../common/lifecycle';
import Logger from '../../common/logger';

export interface BaseTreeNode {
	reveal(element: TreeNode, options?: { select?: boolean; focus?: boolean; expand?: boolean | number }): Thenable<void>;
	refresh(treeNode?: TreeNode): void;
	children: TreeNode[] | undefined;
	view: vscode.TreeView<TreeNode>;
}

export type TreeNodeParent = TreeNode | BaseTreeNode;

export abstract class TreeNode extends Disposable {
	protected children: TreeNode[] | undefined;
	childrenDisposables: vscode.Disposable[] = [];
	label?: string;
	accessibilityInformation?: vscode.AccessibilityInformation;
	id?: string;

	constructor(public parent: TreeNodeParent) {
		super();
	}

	abstract getTreeItem(): vscode.TreeItem | Promise<vscode.TreeItem>;
	getParent(): TreeNode | undefined {
		if (this.parent instanceof TreeNode) {
			return this.parent;
		}
	}

	async reveal(
		treeNode: TreeNode,
		options?: { select?: boolean; focus?: boolean; expand?: boolean | number },
	): Promise<void> {
		try {
			await this.parent.reveal(treeNode || this, options);
		} catch (e) {
			Logger.error(e, 'TreeNode');
		}
	}

	refresh(treeNode?: TreeNode): void {
		return this.parent.refresh(treeNode);
	}

	async cachedChildren(): Promise<TreeNode[]> {
		if (this.children && this.children.length) {
			return this.children;
		}
		return this.getChildren();
	}

	async getChildren(shouldDispose: boolean = true): Promise<TreeNode[]> {
		if (this.children && this.children.length && shouldDispose) {
			disposeAll(this.children);
		}
		return [];
	}

	updateFromCheckboxChanged(_newState: vscode.TreeItemCheckboxState): void { }

	override dispose(): void {
		super.dispose();
		if (this.childrenDisposables) {
			disposeAll(this.childrenDisposables);
		}
	}
}

export class LabelOnlyNode extends TreeNode {
	public override readonly label: string = '';
	constructor(parent: TreeNodeParent, label: string) {
		super(parent);
		this.label = label;
	}
	getTreeItem(): vscode.TreeItem {
		return new vscode.TreeItem(this.label);
	}

}