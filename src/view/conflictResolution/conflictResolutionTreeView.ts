/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { commands } from '../../common/executeCommands';
import { Disposable } from '../../common/lifecycle';
import { Conflict, ConflictResolutionModel } from '../../github/conflictResolutionModel';

interface ConflictNode {
	conflict: Conflict;
}

export class ConflictResolutionTreeView extends Disposable implements vscode.TreeDataProvider<ConflictNode> {
	private readonly _treeView: vscode.TreeView<ConflictNode>;
	private readonly _onDidChangeTreeData: vscode.EventEmitter<void | ConflictNode[]> = this._register(new vscode.EventEmitter<void | ConflictNode[]>());
	onDidChangeTreeData: vscode.Event<void | ConflictNode[]> = this._onDidChangeTreeData.event;

	constructor(private readonly _conflictResolutionModel: ConflictResolutionModel) {
		super();
		this._treeView = this._register(vscode.window.createTreeView('github:conflictResolution', { treeDataProvider: this }));
		this._register(this._conflictResolutionModel.onAddedResolution(() => this._onDidChangeTreeData.fire()));
		commands.focusView('github:conflictResolution');
	}

	async getTreeItem(element: ConflictNode): Promise<vscode.TreeItem> {
		const resource = vscode.Uri.from({ path: element.conflict.prHeadFilePath, scheme: 'conflictResolution' });
		const item = new vscode.TreeItem(resource);
		if (this._conflictResolutionModel.isResolved(element.conflict.prHeadFilePath)) {
			item.iconPath = new vscode.ThemeIcon('check');
			item.command = {
				command: 'vscode.diff',
				arguments: [
					this._conflictResolutionModel.baseUri(element.conflict),
					this._conflictResolutionModel.mergeOutputUri(element.conflict),
					`Merge result for ${element.conflict.prHeadFilePath}`,
				],
				title: vscode.l10n.t('View Merge Result')
			};
		} else {
			item.command = {
				command: 'pr.resolveConflict',
				title: vscode.l10n.t('Resolve Conflict'),
				arguments: [element.conflict]
			};
		}

		return item;
	}

	async getChildren(element?: ConflictNode | undefined): Promise<ConflictNode[]> {
		if (element) {
			return [];
		}
		const exit = new vscode.MarkdownString();
		exit.isTrusted = {
			enabledCommands: ['pr.exitConflictResolutionMode', 'pr.completeMerge']
		};
		let children: ConflictNode[] = [];
		if (!this._conflictResolutionModel.isResolvable()) {
			exit.appendMarkdown(vscode.l10n.t('Not all conflicts can be resolved here. Check out the pull request to manually resolve conflicts.\n\n[Exit conflict resolution mode](command:pr.exitConflictResolutionMode)'));
		} else {
			if (this._conflictResolutionModel.areAllConflictsResolved) {
				exit.appendMarkdown(vscode.l10n.t('All conflicts have been resolved.\n\n[Complete merge](command:pr.completeMerge)\n\n[Exit without merging](command:pr.exitConflictResolutionMode)'));
			} else {
				exit.appendMarkdown(vscode.l10n.t('Resolve all conflicts or [exit conflict resolution mode](command:pr.exitConflictResolutionMode)'));
			}
			children = Array.from(this._conflictResolutionModel.startingConflicts.values()).map(conflict => ({ conflict }));
		}
		(this._treeView as vscode.TreeView2<ConflictNode>).message = exit;
		return children;
	}
}