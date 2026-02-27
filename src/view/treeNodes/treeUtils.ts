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

		for (const [node, newState] of checkboxUpdates.items) {
			if (node instanceof FileChangeNode) {
				if (newState === vscode.TreeItemCheckboxState.Checked) {
					checkedNodes.push(node);
				} else {
					uncheckedNodes.push(node);
				}
				node.updateFromCheckboxChanged(newState);
			} else if (node instanceof DirectoryTreeNode) {
				collectAllDescendants(node, newState, checkedNodes, uncheckedNodes);
			}
		}

		if (selectionContainsUpdates) {
			for (const selected of selection) {
				if (!(selected instanceof FileChangeNode)) {
					continue;
				}
				if (!checkedNodes.includes(selected) && !uncheckedNodes.includes(selected)) {
					// Only process files that have checkboxes (files without checkboxState, like those under commits, are skipped)
					if (selected.checkboxState?.state === vscode.TreeItemCheckboxState.Unchecked) {
						selected.updateFromCheckboxChanged(vscode.TreeItemCheckboxState.Checked);
						checkedNodes.push(selected);
					} else if (selected.checkboxState?.state === vscode.TreeItemCheckboxState.Checked) {
						selected.updateFromCheckboxChanged(vscode.TreeItemCheckboxState.Unchecked);
						uncheckedNodes.push(selected);
					}
				}
			}
		}

		// Refresh the tree so checkbox visual state updates.
		// Refreshing the topmost affected directory will cascade to all descendants.
		const allAffected = [...checkedNodes, ...uncheckedNodes];
		const refreshedDirs = new Set<DirectoryTreeNode>();
		for (const node of allAffected) {
			let topDir: DirectoryTreeNode | undefined;
			let parent = node.getParent();
			while (parent instanceof DirectoryTreeNode) {
				topDir = parent;
				parent = parent.getParent();
			}
			if (topDir && !refreshedDirs.has(topDir)) {
				refreshedDirs.add(topDir);
				topDir.refresh(topDir);
			}
		}
		// If a directory was clicked directly, also refresh it
		for (const [node] of checkboxUpdates.items) {
			if (node instanceof DirectoryTreeNode && !refreshedDirs.has(node)) {
				refreshedDirs.add(node);
				node.refresh(node);
			}
		}
		// For flat layout (files have no directory parent), refresh file nodes directly
		for (const node of allAffected) {
			const parent = node.getParent();
			if (!(parent instanceof DirectoryTreeNode)) {
				node.refresh(node);
			}
		}

		// Send API requests without firing state change events (UI is already updated optimistically).
		// This prevents race conditions where overlapping markFiles calls cause checkboxes to flicker.
		if (checkedNodes.length > 0) {
			const prModel = checkedNodes[0].pullRequest;
			const filenames = checkedNodes.map(n => n.fileName);
			prModel.markFiles(filenames, false, 'viewed').then(() => {
				checkedNodes[0].refreshFileViewedContext();
			});
		}
		if (uncheckedNodes.length > 0) {
			const prModel = uncheckedNodes[0].pullRequest;
			const filenames = uncheckedNodes.map(n => n.fileName);
			prModel.markFiles(filenames, false, 'unviewed').then(() => {
				uncheckedNodes[0].refreshFileViewedContext();
			});
		}
	}

	function collectAllDescendants(
		dirNode: DirectoryTreeNode,
		newState: vscode.TreeItemCheckboxState,
		checkedNodes: FileChangeNode[],
		uncheckedNodes: FileChangeNode[]
	): void {
		for (const child of dirNode._children) {
			if (child instanceof FileChangeNode) {
				if (newState === vscode.TreeItemCheckboxState.Checked) {
					checkedNodes.push(child);
				} else {
					uncheckedNodes.push(child);
				}
				child.updateFromCheckboxChanged(newState);
			} else if (child instanceof DirectoryTreeNode) {
				collectAllDescendants(child, newState, checkedNodes, uncheckedNodes);
			}
		}
	}
}