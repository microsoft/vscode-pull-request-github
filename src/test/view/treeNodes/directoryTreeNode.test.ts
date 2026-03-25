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
	describe('allChildrenViewed', function () {
		it('returns true when all file children are checked', function () {
			const dirNode = new DirectoryTreeNode(createMockParent(), 'src');

			const file1 = new MockFileNode(dirNode);
			file1.checkboxState = { state: vscode.TreeItemCheckboxState.Checked };
			const file2 = new MockFileNode(dirNode);
			file2.checkboxState = { state: vscode.TreeItemCheckboxState.Checked };

			(dirNode._children as any[]).push(file1, file2);

			assert.strictEqual(dirNode.allChildrenViewed(), true);
		});

		it('returns false when some file children are unchecked', function () {
			const dirNode = new DirectoryTreeNode(createMockParent(), 'src');

			const file1 = new MockFileNode(dirNode);
			file1.checkboxState = { state: vscode.TreeItemCheckboxState.Checked };
			const file2 = new MockFileNode(dirNode);
			file2.checkboxState = { state: vscode.TreeItemCheckboxState.Unchecked };

			(dirNode._children as any[]).push(file1, file2);

			assert.strictEqual(dirNode.allChildrenViewed(), false);
		});

		it('returns false when a file child has no checkboxState', function () {
			const dirNode = new DirectoryTreeNode(createMockParent(), 'src');

			const file1 = new MockFileNode(dirNode);
			file1.checkboxState = { state: vscode.TreeItemCheckboxState.Checked };
			const file2 = new MockFileNode(dirNode);
			// file2 has no checkboxState

			(dirNode._children as any[]).push(file1, file2);

			assert.strictEqual(dirNode.allChildrenViewed(), false);
		});

		it('returns true when nested directories have all children checked', function () {
			const parentDir = new DirectoryTreeNode(createMockParent(), 'src');
			const childDir = new DirectoryTreeNode(parentDir, 'utils');

			const file1 = new MockFileNode(childDir);
			file1.checkboxState = { state: vscode.TreeItemCheckboxState.Checked };

			(childDir._children as any[]).push(file1);
			parentDir._children.push(childDir);

			assert.strictEqual(parentDir.allChildrenViewed(), true);
		});

		it('returns false when nested directories have unchecked children', function () {
			const parentDir = new DirectoryTreeNode(createMockParent(), 'src');
			const childDir = new DirectoryTreeNode(parentDir, 'utils');

			const file1 = new MockFileNode(childDir);
			file1.checkboxState = { state: vscode.TreeItemCheckboxState.Unchecked };

			(childDir._children as any[]).push(file1);
			parentDir._children.push(childDir);

			assert.strictEqual(parentDir.allChildrenViewed(), false);
		});

		it('returns true when empty directory has no children', function () {
			const dirNode = new DirectoryTreeNode(createMockParent(), 'empty');
			assert.strictEqual(dirNode.allChildrenViewed(), true);
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
});
