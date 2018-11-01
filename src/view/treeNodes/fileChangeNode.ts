/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { DiffHunk, DiffChangeType } from '../../common/diffHunk';
import { GitChangeType } from '../../common/file';
import { Resource } from '../../common/resources';
import { IPullRequestModel } from '../../github/interface';
import { TreeNode } from './treeNode';
import { Comment } from '../../common/comment';
import { getDiffLineByPosition, getZeroBased } from '../../common/diffPositionMapping';
import { toFileChangeNodeUri } from '../../common/uri';

/**
 * File change node whose content can not be resolved locally and we direct users to GitHub.
 */
export class RemoteFileChangeNode extends TreeNode implements vscode.TreeItem {
	public label: string;
	public iconPath?: string | vscode.Uri | { light: string | vscode.Uri; dark: string | vscode.Uri };
	public command: vscode.Command;

	constructor(
		public readonly pullRequest: IPullRequestModel,
		public readonly status: GitChangeType,
		public readonly fileName: string,
		public readonly blobUrl: string
	) {
		super();
		this.label = fileName.replace(this.getDirectoryPath(), '');
		this.iconPath = Resource.getFileStatusUri(this);

		this.command = {
			title: 'show remote file',
			command: 'vscode.open',
			arguments: [
				vscode.Uri.parse(this.blobUrl)
			]
		};
	}

	getTreeItem(): vscode.TreeItem {
		return this;
	}

	getDirectoryPath(): string {
		const fileName = this.fileName;
		const lastDirectorySeparatorIndex = fileName.lastIndexOf('/');

		if (lastDirectorySeparatorIndex !== -1) {
			return fileName.substring(0, lastDirectorySeparatorIndex + 1);
		}
	}
}

/**
 * File change node whose content is stored in memory and resolved when being revealed.
 */
export class InMemFileChangeNode extends TreeNode implements vscode.TreeItem {
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
		public readonly previousFileName: string | undefined,
		public readonly blobUrl: string,
		public readonly filePath: vscode.Uri,
		public readonly parentFilePath: vscode.Uri,
		public readonly isPartial: boolean,
		public readonly patch: string,
		public readonly diffHunks: DiffHunk[],

		public comments: Comment[] = [],
		public readonly sha?: string,
	) {
		super();
		this.contextValue = 'filechange';
		this.label = fileName.replace(this.getDirectoryPath(), '');
		this.iconPath = Resource.getFileStatusUri(this);
		this.resourceUri = toFileChangeNodeUri(this.filePath, comments.length > 0);

		let opts: vscode.TextDocumentShowOptions = {
			preserveFocus: true
		};

		if (this.comments && this.comments.length) {
			let sortedActiveComments = this.comments.filter(comment => comment.position).sort((a, b) => {
				return a.position - b.position;
			});

			if (sortedActiveComments.length) {
				let comment = sortedActiveComments[0];
				let diffLine = getDiffLineByPosition(this.diffHunks, comment.position === null ? comment.original_position : comment.position);

				if (diffLine) {
					// If the diff is a deletion, the new line number is invalid so use the old line number. Ensure the line number is positive.
					let lineNumber = Math.max(getZeroBased(diffLine.type === DiffChangeType.Delete ? diffLine.oldLineNumber : diffLine.newLineNumber), 0);
					opts.selection = new vscode.Range(lineNumber, 0, lineNumber, 0);
				}
			}
		}

		this.command = {
			title: 'show diff',
			command: 'pr.openDiffView',
			arguments: [
				this.parentFilePath,
				this.filePath,
				this.fileName,
				this.isPartial,
				opts
			]
		};
	}

	getTreeItem(): vscode.TreeItem {
		return this;
	}

	getDirectoryPath(): string {
		const fileName = this.fileName;
		const lastDirectorySeparatorIndex = fileName.lastIndexOf('/');

		if (lastDirectorySeparatorIndex !== -1) {
			return fileName.substring(0, lastDirectorySeparatorIndex + 1);
		}
	}
}

/**
 * File change node whose content can be resolved by git commit sha.
 */
export class GitFileChangeNode extends TreeNode implements vscode.TreeItem {
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
		public readonly isPartial: boolean,
		public readonly diffHunks: DiffHunk[],
		public comments: Comment[] = [],
		public readonly sha?: string,
	) {
		super();
		this.contextValue = 'filechange';
		this.label = fileName;
		this.iconPath = Resource.getFileStatusUri(this);
		this.resourceUri = toFileChangeNodeUri(this.filePath, comments.length > 0);

		let opts: vscode.TextDocumentShowOptions = {
			preserveFocus: true
		};

		if (this.comments && this.comments.length) {
			let sortedActiveComments = this.comments.filter(comment => comment.position).sort((a, b) => {
				return a.position - b.position;
			});

			if (sortedActiveComments.length) {
				let comment = sortedActiveComments[0];
				let diffLine = getDiffLineByPosition(this.diffHunks, comment.position === null ? comment.original_position : comment.position);

				if (diffLine) {
					// If the diff is a deletion, the new line number is invalid so use the old line number. Ensure the line number is positive.
					let lineNumber = Math.max(getZeroBased(diffLine.type === DiffChangeType.Delete ? diffLine.oldLineNumber : diffLine.newLineNumber), 0);
					opts.selection = new vscode.Range(lineNumber, 0, lineNumber, 0);
				}
			}
		}

		this.command = {
			title: 'show diff',
			command: 'pr.openDiffView',
			arguments: [
				this.parentFilePath,
				this.filePath,
				this.fileName,
				this.isPartial,
				opts
			]
		};
	}

	getTreeItem(): vscode.TreeItem {
		return this;
	}

	getDirectoryPath(): string {
		const fileName = this.fileName;
		const lastDirectorySeparatorIndex = fileName.lastIndexOf('/');

		if (lastDirectorySeparatorIndex !== -1) {
			return fileName.substring(0, lastDirectorySeparatorIndex + 1);
		}
	}
}

/**
 * Directory node for containing child file change nodes.
 */
export class FileChangeDirectoryNode extends TreeNode implements vscode.TreeItem {
	public label: string;
	public collapsibleState: vscode.TreeItemCollapsibleState;
	private _fileChanges: (RemoteFileChangeNode | InMemFileChangeNode)[] = [];

	constructor(
		public readonly pullRequest: IPullRequestModel,
		public readonly directoryPath: string,
	) {
		super();

		this.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
		this.label = directoryPath;
	}

	async getChildren(): Promise<TreeNode[]> {
		this.childrenDisposables = this._fileChanges;
		return this._fileChanges;
	}

	getTreeItem(): vscode.TreeItem {
		return this;
	}

	addFileChange(fileChange: (RemoteFileChangeNode | InMemFileChangeNode)) {
		this._fileChanges.push(fileChange);
	}
}

export function gitFileChangeNodeFilter(nodes: (GitFileChangeNode | RemoteFileChangeNode)[]): GitFileChangeNode[] {
	return nodes.filter(node => node instanceof GitFileChangeNode) as GitFileChangeNode[];
}