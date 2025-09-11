/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { GitFileChangeNode, InMemFileChangeNode, RemoteFileChangeNode } from './fileChangeNode';
import { TreeNode, TreeNodeParent } from './treeNode';

export class DirectoryTreeNode extends TreeNode implements vscode.TreeItem {
	public collapsibleState: vscode.TreeItemCollapsibleState;
	public override _children: (RemoteFileChangeNode | InMemFileChangeNode | GitFileChangeNode | DirectoryTreeNode)[] = [];
	private _pathToChild: Map<string, DirectoryTreeNode> = new Map();
	public checkboxState?: { state: vscode.TreeItemCheckboxState, tooltip: string, accessibilityInformation: vscode.AccessibilityInformation };

	constructor(parent: TreeNodeParent, label: string) {
		super(parent);
		this.label = label;
		this.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
	}

	override async getChildren(): Promise<TreeNode[]> {
		return this._children;
	}

	public finalize(): void {
		this.trimTree();
		this.sort();
	}

	private _trimTree(): void {
		if (this._children.length === 0) {
			return;
		}

		this._children.forEach(n => {
			if (n instanceof DirectoryTreeNode) {
				n.trimTree(); // recursive
			}
		});

		// merge if this only have single directory, eg:
		// - a
		//   - b
		//     - c
		// becomes:
		// - a/b
		//   - c
		if (this._children.length !== 1) {
			return;
		}
		const child = this._children[0];
		if (!(child instanceof DirectoryTreeNode)) {
			return;
		}

		// perform the merge
		this.label = this.label + '/' + child.label;
		if (this.label.startsWith('/')) {
			this.label = this.label.substr(1);
		}
		this._children = child._children;
		this._children.forEach(child => { child.parent = this; });
	}

	private _sort(): void {
		if (this._children.length <= 1) {
			return;
		}

		const dirs: DirectoryTreeNode[] = [];
		const files: (RemoteFileChangeNode | InMemFileChangeNode | GitFileChangeNode)[] = [];

		// process directory
		this._children.forEach(node => {
			if (node instanceof DirectoryTreeNode) {
				node.sort(); // recc
				dirs.push(node);
			} else {
				// files
				files.push(node);
			}
		});

		// sort
		dirs.sort((a, b) => (a.label! < b.label! ? -1 : 1));
		files.sort((a, b) => (a.label! < b.label! ? -1 : 1));

		this._children = [...dirs, ...files];
	}

	public addFile(file: GitFileChangeNode | RemoteFileChangeNode | InMemFileChangeNode): void {
		const paths = file.changeModel.fileName.split('/');
		this.addPathRecc(paths, file);
	}

	private _addPathRecc(paths: string[], file: GitFileChangeNode | RemoteFileChangeNode | InMemFileChangeNode): void {
		if (paths.length <= 0) {
			return;
		}

		if (paths.length === 1) {
			file.parent = this;
			this._children.push(file);
			return;
		}

		const dir = paths[0]; // top directory
		const tail = paths.slice(1); // rest

		let node = this.pathToChild.get(dir);
		if (!node) {
			node = new DirectoryTreeNode(this, dir);
			this.pathToChild.set(dir, node);
			this._children.push(node);
		}

		node.addPathRecc(tail, file);
	}

	public allChildrenViewed(): boolean {
		for (const child of this._children) {
			if (child instanceof DirectoryTreeNode) {
				if (!child.allChildrenViewed()) {
					return false;
				}
			} else if (child.checkboxState.state !== vscode.TreeItemCheckboxState.Checked) {
				return false;
			}
		}
		return true;
	}

	private _setCheckboxState(isChecked: boolean) {
		this.checkboxState = isChecked ?
			{ state: vscode.TreeItemCheckboxState.Checked, tooltip: vscode.l10n.t('Mark all files unviewed'), accessibilityInformation: { label: vscode.l10n.t('Mark all files in folder {0} as unviewed', this.label!) } } :
			{ state: vscode.TreeItemCheckboxState.Unchecked, tooltip: vscode.l10n.t('Mark all files viewed'), accessibilityInformation: { label: vscode.l10n.t('Mark all files in folder {0} as viewed', this.label!) } };
	}

	getTreeItem(): vscode.TreeItem {
		this.setCheckboxState(this.allChildrenViewed());
		return this;
	}
}
