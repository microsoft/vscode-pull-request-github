/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'path';
import { DiffHunk, DiffChangeType } from '../../common/diffHunk';
import { GitChangeType } from '../../common/file';
import { TreeNode } from './treeNode';
import { IComment } from '../../common/comment';
import { getDiffLineByPosition, getZeroBased } from '../../common/diffPositionMapping';
import { toResourceUri, asImageDataURI, EMPTY_IMAGE_URI, ReviewUriParams, fromReviewUri } from '../../common/uri';
import { PullRequestModel } from '../../github/pullRequestModel';
import { DecorationProvider } from '../treeDecorationProvider';
import { FolderRepositoryManager } from '../../github/folderRepositoryManager';

export function openFileCommand(uri: vscode.Uri): vscode.Command {
	const activeTextEditor = vscode.window.activeTextEditor;
	const opts: vscode.TextDocumentShowOptions = {
		preserveFocus: true,
		viewColumn: vscode.ViewColumn.Active
	};

	// Check if active text editor has same path as other editor. we cannot compare via
	// URI.toString() here because the schemas can be different. Instead we just go by path.
	if (activeTextEditor && activeTextEditor.document.uri.path === uri.path) {
		opts.selection = activeTextEditor.selection;
	}
	return {
		command: 'vscode.open',
		arguments: [uri, opts],
		title: 'Open File'
	};
}

/**
 * File change node whose content can not be resolved locally and we direct users to GitHub.
 */
export class RemoteFileChangeNode extends TreeNode implements vscode.TreeItem {
	public label: string;
	public description: string;
	public iconPath?: string | vscode.Uri | { light: string | vscode.Uri; dark: string | vscode.Uri } | vscode.ThemeIcon;
	public command: vscode.Command;
	public resourceUri: vscode.Uri;
	public contextValue: string;

	constructor(
		public readonly parent: TreeNode | vscode.TreeView<TreeNode>,
		public readonly pullRequest: PullRequestModel,
		public readonly status: GitChangeType,
		public readonly fileName: string,
		public readonly previousFileName: string | undefined,
		public readonly blobUrl: string,
		public readonly filePath: vscode.Uri,
		public readonly parentFilePath: vscode.Uri
	) {
		super();
		this.contextValue = `filechange:${GitChangeType[status]}`;
		this.label = path.basename(fileName);
		this.description = path.relative('.', path.dirname(fileName));
		this.iconPath = vscode.ThemeIcon.File;
		this.resourceUri = toResourceUri(vscode.Uri.parse(this.blobUrl), pullRequest.number, fileName, status);

		this.command = {
			title: 'show remote file',
			command: 'pr.openDiffView',
			arguments: [
				this
			]
		};
	}

	getTreeItem(): vscode.TreeItem {
		return this;
	}
}

/**
 * File change node whose content is stored in memory and resolved when being revealed.
 */
export class FileChangeNode extends TreeNode implements vscode.TreeItem {
	public label: string;
	public description: string;
	public iconPath?: string | vscode.Uri | { light: string | vscode.Uri; dark: string | vscode.Uri } | vscode.ThemeIcon;
	public resourceUri: vscode.Uri;
	public parentSha: string;
	public contextValue: string;
	public command: vscode.Command;
	public opts: vscode.TextDocumentShowOptions;

	constructor(
		public readonly parent: TreeNode | vscode.TreeView<TreeNode>,
		public readonly pullRequest: PullRequestModel,
		public readonly status: GitChangeType,
		public readonly fileName: string,
		public readonly blobUrl: string | undefined,
		public readonly filePath: vscode.Uri,
		public readonly parentFilePath: vscode.Uri,
		public readonly diffHunks: DiffHunk[],
		public comments: IComment[],
		public readonly sha?: string
	) {
		super();
		this.contextValue = `filechange:${GitChangeType[status]}`;
		this.label = path.basename(fileName);
		this.description = path.relative('.', path.dirname(fileName));
		this.iconPath = vscode.ThemeIcon.File;
		this.opts = {
			preserveFocus: true
		};
		this.update(this.comments);
		this.resourceUri = toResourceUri(vscode.Uri.file(this.fileName), this.pullRequest.number, this.fileName, this.status);
	}

	private findFirstActiveComment() {
		let activeComment: IComment | undefined;
		this.comments.forEach(comment => {
			if (!activeComment && comment.position) {
				activeComment = comment;
				return;
			}

			if (activeComment && comment.position && comment.position < activeComment.position!) {
				activeComment = comment;
			}
		});

		return activeComment;
	}

	update(comments: IComment[]) {
		this.comments = comments;
		DecorationProvider.updateFileComments(this.resourceUri, this.pullRequest.number, this.fileName, comments.length > 0);

		if (comments && comments.length) {
			const comment = this.findFirstActiveComment();
			if (comment) {
				const diffLine = getDiffLineByPosition(this.diffHunks, comment.position === undefined ? comment.originalPosition! : comment.position);
				if (diffLine) {
					// If the diff is a deletion, the new line number is invalid so use the old line number. Ensure the line number is positive.
					const lineNumber = Math.max(getZeroBased(diffLine.type === DiffChangeType.Delete ? diffLine.oldLineNumber : diffLine.newLineNumber), 0);
					this.opts.selection = new vscode.Range(lineNumber, 0, lineNumber, 0);
				}
			}
		} else {
			delete this.opts.selection;
		}
	}

	getCommentPosition(comment: IComment) {
		const diffLine = getDiffLineByPosition(this.diffHunks, comment.position === undefined ? comment.originalPosition! : comment.position);

		if (diffLine) {
			// If the diff is a deletion, the new line number is invalid so use the old line number. Ensure the line number is positive.
			const lineNumber = Math.max(getZeroBased(diffLine.type === DiffChangeType.Delete ? diffLine.oldLineNumber : diffLine.newLineNumber), 0);
			return lineNumber;
		}

		return 0;
	}

	getTreeItem(): vscode.TreeItem {
		return this;
	}

	openFileCommand(): vscode.Command {
		return openFileCommand(this.filePath);
	}

	async openDiffCommand(folderManager: FolderRepositoryManager): Promise<vscode.Command> {
		const parentFilePath = this.parentFilePath;
		const filePath = this.filePath;
		const opts = this.opts;

		let parentURI = await asImageDataURI(parentFilePath, folderManager.repository) || parentFilePath;
		let headURI = await asImageDataURI(filePath, folderManager.repository) || filePath;
		if (parentURI.scheme === 'data' || headURI.scheme === 'data') {
			if (this.status === GitChangeType.ADD) {
				parentURI = EMPTY_IMAGE_URI;
			}
			if (this.status === GitChangeType.DELETE) {
				headURI = EMPTY_IMAGE_URI;
			}
		}

		const pathSegments = filePath.path.split('/');
		return {
			command: 'vscode.diff',
			arguments: [parentURI, headURI, `${pathSegments[pathSegments.length - 1]} (Pull Request)`, opts],
			title: 'Open Changed File in PR'
		};
	}

	async openDiff(folderManager: FolderRepositoryManager): Promise<void> {
		const command = await this.openDiffCommand(folderManager);
		vscode.commands.executeCommand(command.command, ...(command.arguments ?? []));
	}
}

/**
 * File change node whose content is stored in memory and resolved when being revealed.
 */
export class InMemFileChangeNode extends FileChangeNode implements vscode.TreeItem {
	public label: string;
	public description: string;
	public iconPath?: string | vscode.Uri | { light: string | vscode.Uri; dark: string | vscode.Uri } | vscode.ThemeIcon;
	public resourceUri: vscode.Uri;
	public parentSha: string;
	public contextValue: string;
	public command: vscode.Command;
	public opts: vscode.TextDocumentShowOptions;

	constructor(
		public readonly parent: TreeNode | vscode.TreeView<TreeNode>,
		public readonly pullRequest: PullRequestModel,
		public readonly status: GitChangeType,
		public readonly fileName: string,
		public readonly previousFileName: string | undefined,
		public readonly blobUrl: string,
		public readonly filePath: vscode.Uri,
		public readonly parentFilePath: vscode.Uri,
		public isPartial: boolean,
		public readonly patch: string,
		public readonly diffHunks: DiffHunk[],
		public comments: IComment[],
		public readonly sha?: string
	) {
		super(parent, pullRequest, status, fileName, blobUrl, filePath, parentFilePath, diffHunks, comments, sha);
		this.command = {
			title: 'show diff',
			command: 'pr.openDiffView',
			arguments: [this]
		};
	}
}

/**
 * File change node whose content can be resolved by git commit sha.
 */
export class GitFileChangeNode extends FileChangeNode implements vscode.TreeItem {
	public label: string;
	public description: string;
	public iconPath?: string | vscode.Uri | { light: string | vscode.Uri; dark: string | vscode.Uri } | vscode.ThemeIcon;
	public resourceUri: vscode.Uri;
	public parentSha: string;
	public contextValue: string;
	public command: vscode.Command;
	public opts: vscode.TextDocumentShowOptions;

	constructor(
		public readonly parent: TreeNode | vscode.TreeView<TreeNode>,
		private readonly pullRequestManager: FolderRepositoryManager,
		public readonly pullRequest: PullRequestModel,
		public readonly status: GitChangeType,
		public readonly fileName: string,
		public readonly blobUrl: string | undefined,
		public readonly filePath: vscode.Uri,
		public readonly parentFilePath: vscode.Uri,
		public readonly diffHunks: DiffHunk[],
		public comments: IComment[] = [],
		public readonly sha?: string,
	) {
		super(parent, pullRequest, status, fileName, blobUrl, filePath, parentFilePath, diffHunks, comments, sha);
	}

	private _useViewChangesCommand = false;
	public useViewChangesCommand() {
		this._useViewChangesCommand = true;
	}

	private async alternateCommand(): Promise<vscode.Command> {
		if (this.status === GitChangeType.DELETE || this.status === GitChangeType.ADD) {
			// create an empty `review` uri without any path/commit info.
			const emptyFileUri = this.parentFilePath.with({
				query: JSON.stringify({
					path: null,
					commit: null,
				})
			});

			return {
				command: 'vscode.diff',
				arguments: this.status === GitChangeType.DELETE
					? [this.parentFilePath, emptyFileUri, `${this.fileName}`, { preserveFocus: true }]
					: [emptyFileUri, this.parentFilePath, `${this.fileName}`, { preserveFocus: true }],
				title: 'Open Diff'
			};
		}

		// Show the file change in a diff view.
		const { path: filePath, ref, commit, rootPath } = fromReviewUri(this.filePath);
		const previousCommit = `${commit}^`;
		const query: ReviewUriParams = {
			path: filePath,
			ref: ref,
			commit: previousCommit,
			base: true,
			isOutdated: true,
			rootPath
		};
		const previousFileUri = this.filePath.with({ query: JSON.stringify(query) });

		const options: vscode.TextDocumentShowOptions = {
			preserveFocus: true
		};

		if (this.comments && this.comments.length) {
			const sortedOutdatedComments = this.comments.filter(comment => comment.position === undefined).sort((a, b) => {
				return a.originalPosition! - b.originalPosition!;
			});

			if (sortedOutdatedComments.length) {
				const diffLine = getDiffLineByPosition(this.diffHunks, sortedOutdatedComments[0].originalPosition!);

				if (diffLine) {
					const lineNumber = Math.max(getZeroBased(diffLine.type === DiffChangeType.Delete ? diffLine.oldLineNumber : diffLine.newLineNumber), 0);
					options.selection = new vscode.Range(lineNumber, 0, lineNumber, 0);
				}
			}
		}

		return {
			command: 'vscode.diff',
			arguments: [previousFileUri, this.filePath, `${this.fileName} from ${(commit || '').substr(0, 8)}`, options],
			title: 'View Changes'
		};
	}

	async resolve(): Promise<void> {
		if (this._useViewChangesCommand) {
			this.command = await this.alternateCommand();
		} else {
			const openDiff = vscode.workspace.getConfiguration().get('git.openDiffOnClick');
			if (openDiff) {
				this.command = await this.openDiffCommand(this.pullRequestManager);
			} else {
				this.command = await this.openFileCommand();
			}
		}
	}
}

/**
 * File change node whose content is resolved from GitHub. For files not yet associated with a pull request.
 */
export class GitHubFileChangeNode extends TreeNode implements vscode.TreeItem {
	public label: string;
	public description: string;
	public iconPath: vscode.ThemeIcon;
	public resourceUri: vscode.Uri;

	public command: vscode.Command;

	constructor(
		public readonly parent: TreeNode | vscode.TreeView<TreeNode>,
		public readonly fileName: string,
		public readonly previousFileName: string | undefined,
		public readonly status: GitChangeType,
		public readonly baseBranch: string,
		public readonly headBranch: string
	) {
		super();
		this.label = fileName;
		this.iconPath = vscode.ThemeIcon.File;
		this.resourceUri = vscode.Uri.file(fileName).with({ scheme: 'github', query: JSON.stringify({ status, fileName }) });

		let parentURI = vscode.Uri.file(fileName).with({ scheme: 'github', query: JSON.stringify({ fileName, branch: baseBranch }) });
		let headURI = vscode.Uri.file(fileName).with({ scheme: 'github', query: JSON.stringify({ fileName, branch: headBranch }) });
		switch (status) {

			case GitChangeType.ADD:
				parentURI = vscode.Uri.file(fileName).with({ scheme: 'github', query: JSON.stringify({ fileName, branch: baseBranch, isEmpty: true }) });
				break;

			case GitChangeType.RENAME:
				parentURI = vscode.Uri.file(previousFileName!).with({ scheme: 'github', query: JSON.stringify({ fileName: previousFileName, branch: baseBranch, isEmpty: true }) });
				break;

			case GitChangeType.DELETE:
				headURI = vscode.Uri.file(fileName).with({ scheme: 'github', query: JSON.stringify({ fileName, branch: headBranch, isEmpty: true }) });
				break;
		}

		this.command = {
			title: 'Open Diff',
			command: 'vscode.diff',
			arguments: [
				parentURI,
				headURI,
				`${fileName} (Pull Request Preview)`
			]
		};
	}

	getTreeItem() {
		return this;
	}
}

export function gitFileChangeNodeFilter(nodes: (GitFileChangeNode | RemoteFileChangeNode)[]): GitFileChangeNode[] {
	return nodes.filter(node => node instanceof GitFileChangeNode) as GitFileChangeNode[];
}