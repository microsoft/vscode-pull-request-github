/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Resource } from '../common/resources';
import { IPullRequestModel } from '../github/interface';
import { FileChangeNode } from './treeNodes/fileChangeNode';
import { DescriptionNode } from './treeNodes/descriptionNode';

export class PullRequestFileChangesTreeDataProvider extends vscode.Disposable implements vscode.TreeDataProvider<FileChangeNode | DescriptionNode> {
	private _onDidChangeTreeData = new vscode.EventEmitter<FileChangeNode | DescriptionNode>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private _localFileChanges: FileChangeNode[] = [];
	private _pullrequest: IPullRequestModel = null;
	constructor(private context: vscode.ExtensionContext) {
		super(() => this.dispose());
		this.context.subscriptions.push(vscode.window.registerTreeDataProvider<FileChangeNode | DescriptionNode>('prStatus', this));
	}

	async showPullRequestFileChanges(pullrequest: IPullRequestModel, fileChanges: FileChangeNode[]) {
		this._pullrequest = pullrequest;
		await vscode.commands.executeCommand(
			'setContext',
			'github:inReviewMode',
			true
		);
		this._localFileChanges = fileChanges;
		this._onDidChangeTreeData.fire();
	}

	async hide() {
		await vscode.commands.executeCommand(
			'setContext',
			'github:inReviewMode',
			false
		);
	}

	getTreeItem(element: FileChangeNode | DescriptionNode): vscode.TreeItem | Thenable<vscode.TreeItem> {
		if (element instanceof DescriptionNode) {
			return element;
		}

		return element.getTreeItem();
	}

	getChildren(element?: FileChangeNode): vscode.ProviderResult<(FileChangeNode | DescriptionNode)[]> {
		if (!element) {
			return [new DescriptionNode('Description', {
				light: Resource.icons.light.Description,
				dark: Resource.icons.dark.Description
			}, this._pullrequest), ...this._localFileChanges];
		} else {
			return [];
		}
	}
}