/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

export abstract class TreeNode implements vscode.Disposable {
	childrenDisposables: vscode.Disposable[];

	constructor() { }
	abstract getTreeItem(): vscode.TreeItem;

	async getChildren(): Promise<TreeNode[]> {
		return [];
	}
	dispose(): void {
		if (this.childrenDisposables && this.childrenDisposables) {
			this.childrenDisposables.forEach(dispose => dispose.dispose());
		}
	}
}