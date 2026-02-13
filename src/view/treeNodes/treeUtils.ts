/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { DirectoryTreeNode } from './directoryTreeNode';
import { FileChangeNode } from './fileChangeNode';
import { TreeNode } from './treeNode';

export namespace TreeUtils {
	export function processCheckboxUpdates(checkboxUpdates: vscode.TreeCheckboxChangeEvent<TreeNode>, selection: readonly TreeNode[]) {
		const selectionContainsUpdates = selection.some(node => checkboxUpdates.items.some(update => update[0] === node));

		const checkedNodes: FileChangeNode[] = [];
		const uncheckedNodes: FileChangeNode[] = [];

		// The first item is the one the user actually clicked.
		// Only collect missing descendants if a directory was clicked directly.
		const firstNode = checkboxUpdates.items[0]?.[0];

		const eventNodes = new Set<TreeNode>(checkboxUpdates.items.map(([node]) => node));

		checkboxUpdates.items.forEach(checkboxUpdate => {
			const node = checkboxUpdate[0];
			const newState = checkboxUpdate[1];

			if (node instanceof FileChangeNode) {
				if (newState === vscode.TreeItemCheckboxState.Checked) {
					checkedNodes.push(node);
				} else {
					uncheckedNodes.push(node);
				}
			} else if (firstNode instanceof DirectoryTreeNode && node === firstNode) {
				// VS Code auto-propagates to rendered children, but unrendered children
				// (due to virtual scrolling) won't be in the event. Collect those missing ones.
				collectMissingDescendants(firstNode, newState, checkedNodes, uncheckedNodes, eventNodes);
			}

			node.updateFromCheckboxChanged(newState);
		});

		if (selectionContainsUpdates) {
			for (const selected of selection) {
				if (!(selected instanceof FileChangeNode)) {
					continue;
				}
				if (!checkedNodes.includes(selected) && !uncheckedNodes.includes(selected)) {
					// Only process files that have checkboxes (files without checkboxState, like those under commits, are skipped)
					if (selected.checkboxState?.state === vscode.TreeItemCheckboxState.Unchecked) {
						checkedNodes.push(selected);
					} else if (selected.checkboxState?.state === vscode.TreeItemCheckboxState.Checked) {
						uncheckedNodes.push(selected);
					}
				}
			}
		}

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

	/**
	 * Collect descendant FileChangeNodes that are NOT already in the event.
	 * These are children VS Code missed because they weren't rendered (virtual scrolling).
	 */
	function collectMissingDescendants(
		dirNode: DirectoryTreeNode,
		newState: vscode.TreeItemCheckboxState,
		checkedNodes: FileChangeNode[],
		uncheckedNodes: FileChangeNode[],
		eventNodes: Set<TreeNode>
	): void {
		for (const child of dirNode._children) {
			if (eventNodes.has(child)) {
				continue;
			}
			if (child instanceof FileChangeNode) {
				if (newState === vscode.TreeItemCheckboxState.Checked) {
					checkedNodes.push(child);
				} else {
					uncheckedNodes.push(child);
				}
				child.updateFromCheckboxChanged(newState);
			} else if (child instanceof DirectoryTreeNode) {
				collectMissingDescendants(child, newState, checkedNodes, uncheckedNodes, eventNodes);
			}
		}
	}
}