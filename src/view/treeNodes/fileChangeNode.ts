/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import { GitPullRequestCommentThread } from 'azure-devops-node-api/interfaces/GitInterfaces';
import * as vscode from 'vscode';
import { FolderRepositoryManager } from '../../azdo/folderRepositoryManager';
import { PullRequestModel } from '../../azdo/pullRequestModel';
import { getPositionFromThread, removeLeadingSlash } from '../../azdo/utils';
import { ViewedState } from '../../common/comment';
import { DiffChangeType, DiffHunk } from '../../common/diffHunk';
import { getDiffLineByPosition, getZeroBased } from '../../common/diffPositionMapping';
import { GitChangeType } from '../../common/file';
import { asImageDataURI, EMPTY_IMAGE_URI, toResourceUri } from '../../common/uri';
import { FileViewedDecorationProvider } from '../fileViewedDecorationProvider';
import { DecorationProvider } from '../treeDecorationProvider';
import { TreeNode, TreeNodeParent } from './treeNode';

/**
 * File change node whose content can not be resolved locally and we direct users to GitHub.
 */
export class RemoteFileChangeNode extends TreeNode implements vscode.TreeItem {
	public description: string;
	public iconPath?: string | vscode.Uri | { light: string | vscode.Uri; dark: string | vscode.Uri } | vscode.ThemeIcon;
	public command: vscode.Command;
	public resourceUri: vscode.Uri;
	public contextValue: string;
	public childrenDisposables: vscode.Disposable[] = [];
	private _viewed: ViewedState;

	constructor(
		public readonly parent: TreeNodeParent,
		public readonly pullRequest: PullRequestModel,
		public readonly status: GitChangeType,
		public readonly fileName: string,
		public readonly previousFileName: string | undefined,
		public readonly blobUrl: string,
		public readonly filePath: vscode.Uri,
		public readonly parentFilePath: vscode.Uri,
		public readonly sha?: string,
	) {
		super();
		const viewed = this.pullRequest.fileChangeViewedState[sha] ?? ViewedState.UNVIEWED;
		this.contextValue = `filechange:${GitChangeType[status]}:${viewed === ViewedState.VIEWED ? 'viewed' : 'unviewed'}`;
		this.label = path.basename(fileName);
		this.description = path.relative('.', path.dirname(fileName));
		this.iconPath = vscode.ThemeIcon.File;
		this.resourceUri = toResourceUri(vscode.Uri.parse(this.blobUrl), pullRequest.getPullRequestId(), fileName, status);

		this.command = {
			title: 'show remote file',
			command: 'azdopr.openDiffView',
			arguments: [this],
		};

		this.childrenDisposables.push(
			this.pullRequest.onDidChangeFileViewedState(e => {
				const matchingChange = e.changed.find(viewStateChange => viewStateChange.fileSHA === this.sha);
				if (matchingChange) {
					this.updateViewed(matchingChange.viewed);
					this.refresh(this);
				}
			}),
		);
	}

	updateViewed(viewed: ViewedState) {
		if (this._viewed === viewed) {
			return;
		}

		this._viewed = viewed;
		this.contextValue = `filechange:${GitChangeType[this.status]}:${viewed === ViewedState.VIEWED ? 'viewed' : 'unviewed'}`;
		FileViewedDecorationProvider.updateFileViewedState(
			this.resourceUri,
			this.pullRequest.getPullRequestId(),
			this.fileName,
			viewed,
		);
	}

	getTreeItem(): vscode.TreeItem {
		return this;
	}
}

/**
 * File change node whose content is stored in memory and resolved when being revealed.
 */
export class FileChangeNode extends TreeNode implements vscode.TreeItem {
	public description: string;
	public iconPath?: string | vscode.Uri | { light: string | vscode.Uri; dark: string | vscode.Uri } | vscode.ThemeIcon;
	public resourceUri: vscode.Uri;
	public parentSha: string;
	public contextValue: string;
	public command: vscode.Command;
	public opts: vscode.TextDocumentShowOptions;

	public childrenDisposables: vscode.Disposable[] = [];
	private _viewed: ViewedState;

	constructor(
		public readonly parent: TreeNodeParent,
		public readonly pullRequest: PullRequestModel,
		public readonly status: GitChangeType,
		public readonly fileName: string,
		public readonly blobUrl: string | undefined,
		public readonly filePath: vscode.Uri,
		public readonly parentFilePath: vscode.Uri,
		public readonly diffHunks: DiffHunk[],
		public comments: GitPullRequestCommentThread[],
		public readonly sha?: string,
	) {
		super();
		const viewed = this.pullRequest.fileChangeViewedState[sha] ?? ViewedState.UNVIEWED;
		this.contextValue = `filechange:${GitChangeType[status]}:${viewed === ViewedState.VIEWED ? 'viewed' : 'unviewed'}`;
		this.label = path.basename(fileName);
		this.description = path.relative('.', path.dirname(removeLeadingSlash(fileName)));
		this.iconPath = vscode.ThemeIcon.File;
		this.opts = {
			preserveFocus: true,
		};
		this.update(this.comments);
		this.resourceUri = toResourceUri(
			vscode.Uri.file(this.fileName),
			this.pullRequest.getPullRequestId(),
			this.fileName,
			this.status,
		);
		this.updateViewed(viewed);

		this.childrenDisposables.push(
			this.pullRequest.onDidChangeFileViewedState(e => {
				const matchingChange = e.changed.find(viewStateChange => viewStateChange.fileSHA === this.sha);
				if (matchingChange) {
					this.updateViewed(matchingChange.viewed);
					this.refresh(this);
				}
			}),
		);
	}

	updateViewed(viewed: ViewedState) {
		if (this._viewed === viewed) {
			return;
		}

		this._viewed = viewed;
		this.contextValue = `filechange:${GitChangeType[this.status]}:${viewed === ViewedState.VIEWED ? 'viewed' : 'unviewed'}`;
		FileViewedDecorationProvider.updateFileViewedState(
			this.resourceUri,
			this.pullRequest.getPullRequestId(),
			this.fileName,
			viewed,
		);
	}

	private findFirstActiveComment() {
		let activeComment: GitPullRequestCommentThread | undefined;
		this.comments.forEach(comment => {
			if (!activeComment) {
				activeComment = comment;
				return;
			}

			if (!!activeComment && comment.threadContext) {
				const position = getPositionFromThread(comment) ?? 10000;
				const active_position = getPositionFromThread(activeComment) ?? 10000;
				if (position < active_position) {
					activeComment = comment;
				}
			}
		});

		return activeComment;
	}

	update(comments: GitPullRequestCommentThread[]) {
		this.comments = comments;
		DecorationProvider.updateFileComments(
			this.resourceUri,
			this.pullRequest.getPullRequestId(),
			this.fileName,
			comments.length > 0,
		);

		if (comments && comments.length) {
			const comment = this.findFirstActiveComment();
			if (comment) {
				const diffLine = getDiffLineByPosition(this.diffHunks, getPositionFromThread(comment) ?? 0);
				if (diffLine) {
					// If the diff is a deletion, the new line number is invalid so use the old line number. Ensure the line number is positive.
					const lineNumber = Math.max(
						getZeroBased(diffLine.type === DiffChangeType.Delete ? diffLine.oldLineNumber : diffLine.newLineNumber),
						0,
					);
					this.opts.selection = new vscode.Range(lineNumber, 0, lineNumber, 0);
				}
			}
		} else {
			delete this.opts.selection;
		}
	}

	getCommentPosition(comment: GitPullRequestCommentThread) {
		const diffLine = getDiffLineByPosition(this.diffHunks, getPositionFromThread(comment) ?? 0);

		if (diffLine) {
			// If the diff is a deletion, the new line number is invalid so use the old line number. Ensure the line number is positive.
			const lineNumber = Math.max(
				getZeroBased(diffLine.type === DiffChangeType.Delete ? diffLine.oldLineNumber : diffLine.newLineNumber),
				0,
			);
			return lineNumber;
		}

		return 0;
	}

	getTreeItem(): vscode.TreeItem {
		return this;
	}

	async openDiff(folderManager: FolderRepositoryManager): Promise<void> {
		const parentFilePath = this.parentFilePath;
		const filePath = this.filePath;
		const opts = this.opts;

		let parentURI = (await asImageDataURI(parentFilePath, folderManager.repository)) || parentFilePath;
		let headURI = (await asImageDataURI(filePath, folderManager.repository)) || filePath;
		if (parentURI.scheme === 'data' || headURI.scheme === 'data') {
			if (this.status === GitChangeType.ADD) {
				parentURI = EMPTY_IMAGE_URI;
			}
			if (this.status === GitChangeType.DELETE) {
				headURI = EMPTY_IMAGE_URI;
			}
		}

		const pathSegments = filePath.path.split('/');
		vscode.commands.executeCommand(
			'vscode.diff',
			parentURI,
			headURI,
			`${pathSegments[pathSegments.length - 1]} (Pull Request)`,
			opts,
		);
	}
}

/**
 * File change node whose content is stored in memory and resolved when being revealed.
 */
export class InMemFileChangeNode extends FileChangeNode implements vscode.TreeItem {
	constructor(
		public readonly parent: TreeNodeParent,
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
		public comments: GitPullRequestCommentThread[],
		public readonly sha?: string,
	) {
		super(parent, pullRequest, status, fileName, blobUrl, filePath, parentFilePath, diffHunks, comments, sha);
		this.command = {
			title: 'show diff',
			command: 'azdopr.openDiffView',
			arguments: [this],
		};
	}
}

/**
 * File change node whose content can be resolved by git commit sha.
 */
export class GitFileChangeNode extends FileChangeNode implements vscode.TreeItem {
	constructor(
		public readonly parent: TreeNodeParent,
		public readonly pullRequest: PullRequestModel,
		public readonly status: GitChangeType,
		public readonly fileName: string,
		public readonly blobUrl: string | undefined,
		public readonly filePath: vscode.Uri,
		public readonly parentFilePath: vscode.Uri,
		public readonly diffHunks: DiffHunk[],
		public comments: GitPullRequestCommentThread[] = [],
		public readonly sha?: string, // For GitFileChangeNode this is commit id
		public readonly commitId?: string,
	) {
		super(parent, pullRequest, status, fileName, blobUrl, filePath, parentFilePath, diffHunks, comments, sha);
		this.command = {
			title: 'open changed file',
			command: 'azdopr.openChangedFile',
			arguments: [this],
		};
	}
}

export function gitFileChangeNodeFilter(nodes: (GitFileChangeNode | RemoteFileChangeNode)[]): GitFileChangeNode[] {
	return nodes.filter(node => node instanceof GitFileChangeNode) as GitFileChangeNode[];
}
