/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Repository } from '../../api/api';
import { PullRequestModel } from '../../github/pullRequestModel';
import { TreeNode, TreeNodeParent } from './treeNode';

export class DescriptionNode extends TreeNode implements vscode.TreeItem {
	public command?: vscode.Command;
	public contextValue?: string;
	public tooltip: string;

	constructor(
		public parent: TreeNodeParent,
		public label: string,
		public iconPath:
			| string
			| vscode.Uri
			| { light: string | vscode.Uri; dark: string | vscode.Uri }
			| vscode.ThemeIcon,
		public pullRequestModel: PullRequestModel,
		public readonly repository: Repository
	) {
		super();

		this.command = {
			title: 'View Pull Request Description',
			command: 'pr.openDescription',
			arguments: [this],
		};

		this.tooltip = `Description of pull request #${pullRequestModel.number}`;
		this.accessibilityInformation = { label: `Pull request page of pull request number ${pullRequestModel.number}`, role: 'button' };
	}

	getTreeItem(): vscode.TreeItem {
		this.updateContextValue();
		return this;
	}

	protected updateContextValue(): void {
		this.contextValue = 'description' +
			(this.pullRequestModel.hasChangesSinceLastReview ? ':changesSinceReview' : '') +
			(this.pullRequestModel.showChangesSinceReview ? ':active' : ':inactive');
	}
}
