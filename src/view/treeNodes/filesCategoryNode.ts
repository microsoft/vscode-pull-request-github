/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { SETTINGS_NAMESPACE } from '../../constants';
import { DirectoryTreeNode } from './directoryTreeNode';
import { GitFileChangeNode, RemoteFileChangeNode } from './fileChangeNode';
import { TreeNode, TreeNodeParent } from './treeNode';

export class FilesCategoryNode extends TreeNode implements vscode.TreeItem {
	public label: string = 'Files';
	public collapsibleState: vscode.TreeItemCollapsibleState;
	private directories: TreeNode[] = [];

	constructor(public parent: TreeNodeParent, private _fileChanges: (GitFileChangeNode | RemoteFileChangeNode)[]) {
		super();
		this.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;

		// tree view
		const dirNode = new DirectoryTreeNode(this, '');
		this._fileChanges.forEach(f => dirNode.addFile(f));
		dirNode.finalize();
		if (dirNode.label === '') {
			// nothing on the root changed, pull children to parent
			this.directories = dirNode.children;
		} else {
			this.directories = [dirNode];
		}
	}

	getTreeItem(): vscode.TreeItem {
		return this;
	}

	async getChildren(): Promise<TreeNode[]> {
		let nodes: TreeNode[];
		const layout = vscode.workspace.getConfiguration(SETTINGS_NAMESPACE).get<string>('fileListLayout');
		if (layout === 'tree') {
			nodes = this.directories;
		} else {
			nodes = this._fileChanges;
		}
		return Promise.resolve(nodes);
	}
}
