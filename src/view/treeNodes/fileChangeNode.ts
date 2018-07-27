/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { DiffHunk } from '../../common/diffHunk';
import { GitChangeType } from '../../common/file';
import { Resource } from '../../common/resources';
import { IPullRequestModel } from '../../github/interface';
import { TreeNode } from './treeNode';
import { Comment } from '../../common/comment';
import { getDiffLineByPosition } from '../../common/diffPositionMapping';

export class FileChangeNode extends TreeNode implements vscode.TreeItem {
	public label: string;
	public iconPath?: string | vscode.Uri | { light: string | vscode.Uri; dark: string | vscode.Uri };
	public resourceUri: vscode.Uri;
	public parentSha: string;
	public contextValue: string;
	public command: vscode.Command;

	constructor(
		public readonly pullRequest: IPullRequestModel,
		public readonly status: GitChangeType,
		public readonly fileName: string,
		public readonly blobUrl: string,
		public readonly filePath: vscode.Uri,
		public readonly parentFilePath: vscode.Uri,
		public readonly diffHunks: DiffHunk[],
		public readonly comments: Comment[] = [],
		public readonly sha?: string,
	) {
		super();
		this.contextValue = 'filechange';
		this.label = fileName;

		if (this.comments && this.comments.length) {
			this.iconPath = Resource.icons.light.Comment;
		} else {
			this.iconPath = Resource.getFileStatusUri(this);
		}
		this.resourceUri = this.filePath;

		let opts = {};
		if (this.comments && this.comments.length) {
			let sortedActiveComments = this.comments.filter(comment => comment.position).sort((a, b) => {
				return a.position - b.position;
			});

			if (sortedActiveComments.length) {
				let comment = sortedActiveComments[0];
				let diffLine = getDiffLineByPosition(comment.diff_hunks, comment.position === null ? comment.original_position : comment.position);

				if (diffLine) {
					opts = {
						selection: new vscode.Range(diffLine.newLineNumber - 1, 0, diffLine.newLineNumber - 1, 0)
					};
				}
			}
		}

		this.command = {
			title: 'show diff',
			command: 'vscode.diff',
			arguments: [
				this.parentFilePath,
				this.filePath,
				this.fileName,
				opts
			]
		};
	}

	getTreeItem(): vscode.TreeItem {
		return this;
	}

}