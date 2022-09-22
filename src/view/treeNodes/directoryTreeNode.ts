/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { GitFileChangeNode, InMemFileChangeNode, RemoteFileChangeNode } from './fileChangeNode';
import { TreeNode, TreeNodeParent } from './treeNode';

export class DirectoryTreeNode extends TreeNode implements vscode.TreeItem2 {
	public collapsibleState: vscode.TreeItemCollapsibleState;
	public children: (RemoteFileChangeNode | InMemFileChangeNode | GitFileChangeNode | DirectoryTreeNode)[] = [];
	private pathToChild: Map<string, DirectoryTreeNode> = new Map();
	public checkboxState?: { state: vscode.TreeItemCheckboxState, tooltip: string };

	constructor(public parent: TreeNodeParent, public label: string) {
		super();
		this.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
	}

	async getChildren(): Promise<TreeNode[]> {
		return this.children;
	}

	public finalize(): void {
		this.trimTree();
		this.sort();
	}

	private trimTree(): void {
		if (this.children.length === 0) {
			return;
		}

		this.children.forEach(n => {
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
		if (this.children.length !== 1) {
			return;
		}
		const child = this.children[0];
		if (!(child instanceof DirectoryTreeNode)) {
			return;
		}

		// perform the merge
		this.label = this.label + '/' + child.label;
		if (this.label.startsWith('/')) {
			this.label = this.label.substr(1);
		}
		this.children = child.children;
		this.children.forEach(child => { child.parent = this; });
	}

	private sort(): void {
		if (this.children.length <= 1) {
			return;
		}

		const dirs: DirectoryTreeNode[] = [];
		const files: (RemoteFileChangeNode | InMemFileChangeNode | GitFileChangeNode)[] = [];

		// process directory
		this.children.forEach(node => {
			if (node instanceof DirectoryTreeNode) {
				node.sort(); // recc
				dirs.push(node);
			} else {
				// files
				files.push(node);
			}
		});

		// sort
		dirs.sort((a, b) => (a.label < b.label ? -1 : 1));
		files.sort((a, b) => (a.label! < b.label! ? -1 : 1));

		this.children = [...dirs, ...files];
	}

	public addFile(file: GitFileChangeNode | RemoteFileChangeNode | InMemFileChangeNode): void {
		const paths = file.changeModel.fileName.split('/');
		this.addPathRecc(paths, file);
	}

	private addPathRecc(paths: string[], file: GitFileChangeNode | RemoteFileChangeNode | InMemFileChangeNode): void {
		if (paths.length <= 0) {
			return;
		}

		if (paths.length === 1) {
			file.parent = this;
			this.children.push(file);
			return;
		}

		const dir = paths[0]; // top directory
		const tail = paths.slice(1); // rest

		let node = this.pathToChild.get(dir);
		if (!node) {
			node = new DirectoryTreeNode(this, dir);
			this.pathToChild.set(dir, node);
			this.children.push(node);
		}

		node.addPathRecc(tail, file);
	}

	updateCheckbox(newState: vscode.TreeItemCheckboxState) {
		this.children.forEach(child => child.updateCheckbox(newState));
		this.refresh(this);
	}

	public allChildrenViewed(): boolean {
		for (const child of this.children) {
			if (child instanceof DirectoryTreeNode) {
				if (!child.allChildrenViewed()) {
					return false;
				}
			}
			else if (child.checkboxState.state !== vscode.TreeItemCheckboxState.Checked) {
				return false;
			}
		}
		return true;
	}

	public updateParentCheckbox(): boolean {
		// Returns true if the node has been refreshed and false otherwise
		const allChildrenViewed = this.allChildrenViewed();
		if (
			(allChildrenViewed && this.checkboxState?.state === vscode.TreeItemCheckboxState.Checked) ||
			(!allChildrenViewed && this.checkboxState?.state === vscode.TreeItemCheckboxState.Unchecked)
		) {
			return false;
		}

		this.setCheckboxState(allChildrenViewed);
		if (this.parent instanceof DirectoryTreeNode && this.parent.checkboxState !== undefined && this.checkboxState !== this.parent.checkboxState) {
			if (!this.parent.updateParentCheckbox()) {
				this.refresh(this);
				return true;
			}
		}
		else {
			this.refresh(this);
			return true;
		}
		return false;
	}

	private setCheckboxState(isChecked: boolean) {
		this.checkboxState = isChecked ?
			{ state: vscode.TreeItemCheckboxState.Checked, tooltip: 'unmark all files viewed' } :
			{ state: vscode.TreeItemCheckboxState.Unchecked, tooltip: 'mark all files viewed' };
	}

	getTreeItem(): vscode.TreeItem {
		this.setCheckboxState(this.allChildrenViewed());
		return this;
	}
}
