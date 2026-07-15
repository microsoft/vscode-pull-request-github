/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { default as assert } from 'assert';
import { DirectoryTreeNode } from '../../../view/treeNodes/directoryTreeNode';
import { TreeNode, TreeNodeParent } from '../../../view/treeNodes/treeNode';

/**
 * Minimal mock for a file-like child node that supports checkboxState.
 * This is NOT a DirectoryTreeNode so allChildrenViewed() treats it as a leaf file.
 */
class MockFileNode extends TreeNode {
	public checkboxState?: { state: vscode.TreeItemCheckboxState; tooltip?: string; accessibilityInformation?: vscode.AccessibilityInformation };
	constructor(parent: TreeNodeParent) {
		super(parent);
	}
	getTreeItem(): vscode.TreeItem {
		return this;
	}
}

function createMockParent(): TreeNodeParent {
	return {
		refresh: () => { },
		reveal: () => Promise.resolve(),
		children: undefined,
		view: {} as any
	} as any;
}

describe('DirectoryTreeNode', function () {
	describe('allChildrenViewed (via updateCheckboxFromChildren)', function () {
		it('sets Checked when all file children are checked', function () {
			const dirNode = new DirectoryTreeNode(createMockParent(), 'src');

			const file1 = new MockFileNode(dirNode);
			file1.checkboxState = { state: vscode.TreeItemCheckboxState.Checked };
			const file2 = new MockFileNode(dirNode);
			file2.checkboxState = { state: vscode.TreeItemCheckboxState.Checked };

			(dirNode._children as any[]).push(file1, file2);

			dirNode.updateCheckboxFromChildren();
			assert.strictEqual(dirNode.checkboxState?.state, vscode.TreeItemCheckboxState.Checked);
		});

		it('sets Unchecked when some file children are unchecked', function () {
			const dirNode = new DirectoryTreeNode(createMockParent(), 'src');

			const file1 = new MockFileNode(dirNode);
			file1.checkboxState = { state: vscode.TreeItemCheckboxState.Checked };
			const file2 = new MockFileNode(dirNode);
			file2.checkboxState = { state: vscode.TreeItemCheckboxState.Unchecked };

			(dirNode._children as any[]).push(file1, file2);

			dirNode.updateCheckboxFromChildren();
			assert.strictEqual(dirNode.checkboxState?.state, vscode.TreeItemCheckboxState.Unchecked);
		});

		it('sets Unchecked when a file child has no checkboxState', function () {
			const dirNode = new DirectoryTreeNode(createMockParent(), 'src');

			const file1 = new MockFileNode(dirNode);
			file1.checkboxState = { state: vscode.TreeItemCheckboxState.Checked };
			const file2 = new MockFileNode(dirNode);
			// file2 has no checkboxState

			(dirNode._children as any[]).push(file1, file2);

			dirNode.updateCheckboxFromChildren();
			assert.strictEqual(dirNode.checkboxState?.state, vscode.TreeItemCheckboxState.Unchecked);
		});

		it('sets Checked when nested directories have all children checked', function () {
			const parentDir = new DirectoryTreeNode(createMockParent(), 'src');
			const childDir = new DirectoryTreeNode(parentDir, 'utils');

			const file1 = new MockFileNode(childDir);
			file1.checkboxState = { state: vscode.TreeItemCheckboxState.Checked };

			(childDir._children as any[]).push(file1);
			parentDir._children.push(childDir);

			childDir.updateCheckboxFromChildren();
			parentDir.updateCheckboxFromChildren();
			assert.strictEqual(parentDir.checkboxState?.state, vscode.TreeItemCheckboxState.Checked);
		});

		it('sets Unchecked when nested directories have unchecked children', function () {
			const parentDir = new DirectoryTreeNode(createMockParent(), 'src');
			const childDir = new DirectoryTreeNode(parentDir, 'utils');

			const file1 = new MockFileNode(childDir);
			file1.checkboxState = { state: vscode.TreeItemCheckboxState.Unchecked };

			(childDir._children as any[]).push(file1);
			parentDir._children.push(childDir);

			childDir.updateCheckboxFromChildren();
			parentDir.updateCheckboxFromChildren();
			assert.strictEqual(parentDir.checkboxState?.state, vscode.TreeItemCheckboxState.Unchecked);
		});

		it('sets Checked when empty directory has no children', function () {
			const dirNode = new DirectoryTreeNode(createMockParent(), 'empty');
			dirNode.updateCheckboxFromChildren();
			assert.strictEqual(dirNode.checkboxState?.state, vscode.TreeItemCheckboxState.Checked);
		});
	});

	describe('updateCheckboxFromChildren', function () {
		it('sets checkbox to Checked when all children are viewed', function () {
			const dirNode = new DirectoryTreeNode(createMockParent(), 'src');

			const file1 = new MockFileNode(dirNode);
			file1.checkboxState = { state: vscode.TreeItemCheckboxState.Checked };

			(dirNode._children as any[]).push(file1);

			dirNode.updateCheckboxFromChildren();

			assert.strictEqual(dirNode.checkboxState?.state, vscode.TreeItemCheckboxState.Checked);
		});

		it('sets checkbox to Unchecked when not all children are viewed', function () {
			const dirNode = new DirectoryTreeNode(createMockParent(), 'src');

			const file1 = new MockFileNode(dirNode);
			file1.checkboxState = { state: vscode.TreeItemCheckboxState.Checked };
			const file2 = new MockFileNode(dirNode);
			file2.checkboxState = { state: vscode.TreeItemCheckboxState.Unchecked };

			(dirNode._children as any[]).push(file1, file2);

			dirNode.updateCheckboxFromChildren();

			assert.strictEqual(dirNode.checkboxState?.state, vscode.TreeItemCheckboxState.Unchecked);
		});

		it('propagates state through nested directories', function () {
			const parentDir = new DirectoryTreeNode(createMockParent(), 'src');
			const childDir = new DirectoryTreeNode(parentDir, 'utils');

			const file1 = new MockFileNode(childDir);
			file1.checkboxState = { state: vscode.TreeItemCheckboxState.Checked };

			(childDir._children as any[]).push(file1);
			parentDir._children.push(childDir);

			// Update bottom-up (child first, then parent)
			childDir.updateCheckboxFromChildren();
			assert.strictEqual(childDir.checkboxState?.state, vscode.TreeItemCheckboxState.Checked);

			parentDir.updateCheckboxFromChildren();
			assert.strictEqual(parentDir.checkboxState?.state, vscode.TreeItemCheckboxState.Checked);
		});

		it('updates parent to Unchecked when a child is unchecked after being checked', function () {
			const parentDir = new DirectoryTreeNode(createMockParent(), 'src');

			const file1 = new MockFileNode(parentDir);
			file1.checkboxState = { state: vscode.TreeItemCheckboxState.Checked };
			const file2 = new MockFileNode(parentDir);
			file2.checkboxState = { state: vscode.TreeItemCheckboxState.Checked };

			(parentDir._children as any[]).push(file1, file2);

			// All checked → parent should be Checked
			parentDir.updateCheckboxFromChildren();
			assert.strictEqual(parentDir.checkboxState?.state, vscode.TreeItemCheckboxState.Checked);

			// Uncheck one file → parent should be Unchecked
			file2.checkboxState = { state: vscode.TreeItemCheckboxState.Unchecked };
			parentDir.updateCheckboxFromChildren();
			assert.strictEqual(parentDir.checkboxState?.state, vscode.TreeItemCheckboxState.Unchecked);
		});

		it('updates correctly with mixed file and directory children', function () {
			const rootDir = new DirectoryTreeNode(createMockParent(), 'root');
			const subDir = new DirectoryTreeNode(rootDir, 'sub');

			const subFile = new MockFileNode(subDir);
			subFile.checkboxState = { state: vscode.TreeItemCheckboxState.Checked };
			(subDir._children as any[]).push(subFile);

			const rootFile = new MockFileNode(rootDir);
			rootFile.checkboxState = { state: vscode.TreeItemCheckboxState.Checked };

			(rootDir._children as any[]).push(subDir);
			(rootDir._children as any[]).push(rootFile);

			// Update bottom-up
			subDir.updateCheckboxFromChildren();
			rootDir.updateCheckboxFromChildren();
			assert.strictEqual(rootDir.checkboxState?.state, vscode.TreeItemCheckboxState.Checked);

			// Uncheck the sub-directory file
			subFile.checkboxState = { state: vscode.TreeItemCheckboxState.Unchecked };
			subDir.updateCheckboxFromChildren();
			rootDir.updateCheckboxFromChildren();
			assert.strictEqual(subDir.checkboxState?.state, vscode.TreeItemCheckboxState.Unchecked);
			assert.strictEqual(rootDir.checkboxState?.state, vscode.TreeItemCheckboxState.Unchecked);
		});
	});

	describe('parent pointer after phantom-root pull-up', function () {
		// When a tree has multiple top-level directories, a temporary DirectoryTreeNode
		// with label='' (phantom root) is used to build the tree, then its children are
		// pulled up to the actual container. If children are not re-parented, getParent()
		// still returns the phantom DirectoryTreeNode and processCheckboxUpdates fires
		// refresh() on an invisible node, so checkbox state never updates visually.

		it('getParent() returns undefined after child is re-parented to the container', function () {
			const container = createMockParent();
			const phantomRoot = new DirectoryTreeNode(container, '');
			const subDir = new DirectoryTreeNode(phantomRoot, 'src');

			// Before re-parenting: parent is the phantom root DirectoryTreeNode
			assert.ok(subDir.getParent() instanceof DirectoryTreeNode, 'sanity: should point to phantom root before re-parenting');

			// Simulate the pull-up re-parenting fix applied in filesCategoryNode / pullRequestNode / commitNode
			subDir.parent = container;

			// After re-parenting: container is not a TreeNode, so getParent() returns undefined.
			// This means the ancestor walk in processCheckboxUpdates stops here and refresh()
			// is called on the visible subDir node, not the invisible phantom root.
			assert.strictEqual(subDir.getParent(), undefined, 'after re-parenting, getParent() should not return the phantom root');
		});

		it('ancestor walk stops at the topmost visible directory after re-parenting', function () {
			const container = createMockParent();
			const phantomRoot = new DirectoryTreeNode(container, '');
			const topDir = new DirectoryTreeNode(phantomRoot, 'cloud');
			const subDir = new DirectoryTreeNode(topDir, 'helm');
			const file = new MockFileNode(subDir);
			file.checkboxState = { state: vscode.TreeItemCheckboxState.Checked };

			(subDir._children as any[]).push(file);
			topDir._children.push(subDir);

			// Re-parent: simulate fix
			topDir.parent = container;

			// Walk ancestors from file, mimicking processCheckboxUpdates
			const ancestors: TreeNode[] = [];
			let current = file.getParent();
			while (current instanceof DirectoryTreeNode) {
				ancestors.push(current);
				current = current.getParent();
			}

			// Should find subDir and topDir, but NOT the phantom root
			assert.strictEqual(ancestors.length, 2);
			assert.strictEqual(ancestors[0], subDir);
			assert.strictEqual(ancestors[1], topDir);
		});
	});
});
