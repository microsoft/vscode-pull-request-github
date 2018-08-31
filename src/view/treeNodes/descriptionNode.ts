/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IPullRequestModel } from '../../github/interface';
import { TreeNode } from './treeNode';

export class DescriptionNode extends TreeNode implements vscode.TreeItem {
	public command?: vscode.Command;
	public contextValue?: string;

	constructor(public label: string, public iconPath: string | vscode.Uri | { light: string | vscode.Uri; dark: string | vscode.Uri }, public pullRequestModel: IPullRequestModel) {
		super();

		this.command = {
			title: 'View Pull Request Description',
			command: 'pr.openDescription',
			arguments: [
				this.pullRequestModel
			]
		};

		this.contextValue = 'description';
	}

	getTreeItem(): vscode.TreeItem {
		return this;
	}
}
