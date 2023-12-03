/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import Logger from '../../common/logger';
import { dispose } from '../../common/utils';
import { FileChangeNode } from './fileChangeNode';

export interface BaseTreeNode {
	reveal(element: TreeNode, options?: { select?: boolean; focus?: boolean; expand?: boolean | number }): Thenable<void>;
	refresh(treeNode?: TreeNode): void;
	children: TreeNode[] | undefined;
	view: vscode.TreeView<TreeNode>;
}

export type TreeNodeParent = TreeNode | BaseTreeNode;

export const EXPANDED_QUERIES_STATE = 'expandedQueries';

export abstract class TreeNode implements vscode.Disposable {
	protected children: TreeNode[] | undefined;
	childrenDisposables: vscode.Disposable[];
	parent: TreeNodeParent;
	label?: string;
	accessibilityInformation?: vscode.AccessibilityInformation;
	id?: string;

	constructor() { }
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

	async getChildren(): Promise<TreeNode[]> {
		if (this.children && this.children.length) {
			dispose(this.children);
			this.children = [];
		}
		return [];
	}

	updateFromCheckboxChanged(_newState: vscode.TreeItemCheckboxState): void { }

	static processCheckboxUpdates(checkboxUpdates: vscode.TreeCheckboxChangeEvent<TreeNode>) {
		const checkedNodes: FileChangeNode[] = [];
		const uncheckedNodes: FileChangeNode[] = [];

		checkboxUpdates.items.forEach(checkboxUpdate => {
			const node = checkboxUpdate[0];
			const newState = checkboxUpdate[1];

			if (node instanceof FileChangeNode) {
				if (newState == vscode.TreeItemCheckboxState.Checked) {
					checkedNodes.push(node);
				} else {
					uncheckedNodes.push(node);
				}
			}

			node.updateFromCheckboxChanged(newState);
		});

		if (checkedNodes.length > 0) {
			const prModel = checkedNodes[0].pullRequest;
			const filenames = checkedNodes.map(n => n.fileName);
			prModel.markFiles(filenames, true, 'viewed');
		}
		if (uncheckedNodes.length > 0) {
			const prModel = uncheckedNodes[0].pullRequest;
			const filenames = uncheckedNodes.map(n => n.fileName);
			prModel.markFiles(filenames, true, 'viewed');
		}
	}

	dispose(): void {
		if (this.childrenDisposables) {
			dispose(this.childrenDisposables);
			this.childrenDisposables = [];
		}
	}
}

export class LabelOnlyNode extends TreeNode {
	public readonly label: string = '';
	constructor(label: string) {
		super();
		this.label = label;
	}
	getTreeItem(): vscode.TreeItem {
		return new vscode.TreeItem(this.label);
	}

}