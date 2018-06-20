/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { TreeNode } from './TreeNode';
import { IPullRequestModel, IPullRequestManager, PRType } from '../common/pullRequest';
import { Repository } from '../models/repository';
import { Resource } from '../common/resources';
import { PRNode } from './prNode';

export enum PRGroupActionType {
	Empty,
	More
}

export class PRGroupActionNode extends TreeNode implements vscode.TreeItem {
	public readonly label: string;
	public collapsibleState: vscode.TreeItemCollapsibleState;
	public iconPath?: { light: string | vscode.Uri; dark: string | vscode.Uri };
	public type: PRGroupActionType;
	constructor(type: PRGroupActionType) {
		super();
		this.type = type;
		this.collapsibleState = vscode.TreeItemCollapsibleState.None;
		switch (type) {
			case PRGroupActionType.Empty:
				this.label = '0 pull request in this category';
				break;
			case PRGroupActionType.More:
				this.label = 'Load more';
				this.iconPath = {
					light: Resource.icons.light.fold,
					dark: Resource.icons.dark.fold
				};
				break;
			default:
				break;
		}
	}

	getTreeItem(): vscode.TreeItem {
		return this;
	}
}

export class PRGroupTreeNode extends TreeNode implements vscode.TreeItem {
	public readonly label: string;
	public collapsibleState: vscode.TreeItemCollapsibleState;
	public prs: IPullRequestModel[];

	constructor(
		private _prManager: IPullRequestManager,
		private _repository: Repository,
		private _type: PRType
	) {
		super();

		this.prs = [];
		this.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
		switch (_type) {
			case PRType.All:
				this.label = 'All';
				break;
			case PRType.RequestReview:
				this.label = 'Waiting For My Review';
				break;
			case PRType.ReviewedByMe:
				this.label = 'Reviewed By Me';
				break;
			case PRType.Mine:
				this.label = 'Created By Me';
				break;
			case PRType.LocalPullRequest:
				this.label = 'Local Pull Request Branches';
				break;
			default:
				break;
		}
	}

	async getChildren(): Promise<TreeNode[]> {
		let prItems: IPullRequestModel[] = await this._prManager.getPullRequests(this._type);
		if (prItems && prItems.length) {
			return prItems.map(prItem => new PRNode(this._prManager, this._repository, prItem));
		} else {
			return [new PRGroupActionNode(PRGroupActionType.Empty)];
		}
	}

	getTreeItem(): vscode.TreeItem {
		return this;
	}
}
