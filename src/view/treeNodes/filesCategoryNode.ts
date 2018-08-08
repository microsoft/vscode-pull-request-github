/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { FileChangeNode, RemoteFileChangeNode } from './fileChangeNode';
import { TreeNode } from './treeNode';

export class FilesCategoryNode extends TreeNode implements vscode.TreeItem {
	public label: string = 'Files';
	public collapsibleState: vscode.TreeItemCollapsibleState;

	constructor(private _fileChanges: (FileChangeNode | RemoteFileChangeNode)[]) {
		super();
		this.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
	}

	getTreeItem(): vscode.TreeItem {
		return this;
	}

	async getChildren(): Promise<TreeNode[]> {
		return Promise.resolve(this._fileChanges);
	}
}
