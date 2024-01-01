/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { FileChangeNode } from './fileChangeNode';
import { TreeNode } from './treeNode';

export namespace TreeUtils {
	export function processCheckboxUpdates(checkboxUpdates: vscode.TreeCheckboxChangeEvent<TreeNode>) {
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
			prModel.markFiles(filenames, true, 'unviewed');
		}
	}
}