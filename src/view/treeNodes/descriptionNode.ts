/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { PullRequestModel } from '../../azdo/pullRequestModel';
import { TreeNode, TreeNodeParent } from './treeNode';

export class DescriptionNode extends TreeNode implements vscode.TreeItem {
	public command?: vscode.Command;
	public contextValue?: string;
	public tooltip: string;

	constructor(
		public parent: TreeNodeParent,
		public label: string,
		public iconPath: string | vscode.Uri | { light: string | vscode.Uri; dark: string | vscode.Uri } | vscode.ThemeIcon,
		public pullRequestModel: PullRequestModel,
	) {
		super();

		this.command = {
			title: 'View Pull Request Description',
			command: 'azdopr.openDescription',
			arguments: [this],
		};

		this.contextValue = 'description';
		this.tooltip = `Description of pull request #${pullRequestModel.getPullRequestId()}`;
	}

	getTreeItem(): vscode.TreeItem {
		return this;
	}
}
