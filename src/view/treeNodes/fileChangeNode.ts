/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { IComment, ViewedState } from '../../common/comment';
import { DiffHunk, parsePatch } from '../../common/diffHunk';
import { GitChangeType, InMemFileChange, SimpleFileChange } from '../../common/file';
import Logger from '../../common/logger';
import { FILE_LIST_LAYOUT } from '../../common/settingKeys';
import { asImageDataURI, EMPTY_IMAGE_URI, fromReviewUri, ReviewUriParams, toResourceUri } from '../../common/uri';
import { groupBy } from '../../common/utils';
import { FolderRepositoryManager, SETTINGS_NAMESPACE } from '../../github/folderRepositoryManager';
import { IResolvedPullRequestModel, PullRequestModel } from '../../github/pullRequestModel';
import { FILECHANGE_FILE_SCHEME, GITHUB_FILE_SCHEME } from '../compareChangesTreeDataProvider';
import { DecorationProvider } from '../treeDecorationProvider';
import { TreeNode, TreeNodeParent } from './treeNode';

export function openFileCommand(uri: vscode.Uri): vscode.Command {
	const activeTextEditor = vscode.window.activeTextEditor;
	const opts: vscode.TextDocumentShowOptions = {
		preserveFocus: true,
		viewColumn: vscode.ViewColumn.Active,
	};

	// Check if active text editor has same path as other editor. we cannot compare via
	// URI.toString() here because the schemas can be different. Instead we just go by path.
	if (activeTextEditor && activeTextEditor.document.uri.path === uri.path) {
		opts.selection = activeTextEditor.selection;
	}
	return {
		command: 'vscode.open',
		arguments: [uri, opts],
		title: 'Open File',
	};
}

async function openDiffCommand(
	folderManager: FolderRepositoryManager,
	parentFilePath: vscode.Uri,
	filePath: vscode.Uri,
	opts: vscode.TextDocumentShowOptions | undefined,
	status: GitChangeType,
): Promise<vscode.Command> {
	let parentURI = (await asImageDataURI(parentFilePath, folderManager.repository)) || parentFilePath;
	let headURI = (await asImageDataURI(filePath, folderManager.repository)) || filePath;
	if (parentURI.scheme === 'data' || headURI.scheme === 'data') {
		if (status === GitChangeType.ADD) {
			parentURI = EMPTY_IMAGE_URI;
		}
		if (status === GitChangeType.DELETE) {
			headURI = EMPTY_IMAGE_URI;
		}
	}

	const pathSegments = filePath.path.split('/');
	return {
		command: 'vscode.diff',
		arguments: [parentURI, headURI, `${pathSegments[pathSegments.length - 1]} (Pull Request)`, opts],
		title: 'Open Changed File in PR',
	};
}

/**
 * File change node whose content can not be resolved locally and we direct users to GitHub.
 */
export class RemoteFileChangeNode extends TreeNode implements vscode.TreeItem {
	public description: string;
	public iconPath?:
		| string
		| vscode.Uri
		| { light: string | vscode.Uri; dark: string | vscode.Uri }
		| vscode.ThemeIcon;
	public command: vscode.Command;
	public fileChangeResourceUri: vscode.Uri;
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
	) {
		super();
		const viewed = this.pullRequest.fileChangeViewedState[fileName] ?? ViewedState.UNVIEWED;
		this.contextValue = `${FILECHANGE_FILE_SCHEME}:${GitChangeType[status]}:${viewed === ViewedState.VIEWED ? 'viewed' : 'unviewed'
			}`;
		this.label = path.basename(fileName);
		this.description = vscode.workspace.asRelativePath(path.dirname(fileName), false);
		if (this.description === '.') {
			this.description = '';
		}
		this.iconPath = vscode.ThemeIcon.File;
		this.fileChangeResourceUri = toResourceUri(vscode.Uri.parse(this.blobUrl), pullRequest.number, fileName, status);
		this.updateViewed(viewed);
		this.command = {
			command: 'pr.openFileOnGitHub',
			title: 'Open File on GitHub',
			arguments: [this],
		};

		this.childrenDisposables.push(
			this.pullRequest.onDidChangeFileViewedState(e => {
				const matchingChange = e.changed.find(viewStateChange => viewStateChange.fileName === this.fileName);
				if (matchingChange) {
					this.updateViewed(matchingChange.viewed);
					this.refresh(this);
				}
			}),
		);
		this.accessibilityInformation = { label: `View diffs and comments for file ${this.label}`, role: 'link' };
	}

	get resourceUri(): vscode.Uri {
		return this.filePath.with({ query: this.fileChangeResourceUri.query });
	}

	updateViewed(viewed: ViewedState) {
		if (this._viewed === viewed) {
			return;
		}

		this._viewed = viewed;
		this.contextValue = `${FILECHANGE_FILE_SCHEME}:${GitChangeType[this.status]}:${viewed === ViewedState.VIEWED ? 'viewed' : 'unviewed'
			}`;
	}

	getTreeItem(): vscode.TreeItem {
		return this;
	}
}

/**
 * File change node whose content is stored in memory and resolved when being revealed.
 */
export class FileChangeNode extends TreeNode implements vscode.TreeItem {
	public iconPath?:
		| string
		| vscode.Uri
		| { light: string | vscode.Uri; dark: string | vscode.Uri }
		| vscode.ThemeIcon;
	public fileChangeResourceUri: vscode.Uri;
	public parentSha: string;
	public contextValue: string;
	public command: vscode.Command;
	public opts: vscode.TextDocumentShowOptions;

	public childrenDisposables: vscode.Disposable[] = [];
	private _viewed: ViewedState;

	get status(): GitChangeType {
		return this.change.status;
	}

	get fileName(): string {
		return this.change.fileName;
	}

	get blobUrl(): string | undefined {
		return this.change.blobUrl;
	}

	async diffHunks(): Promise<DiffHunk[]> {
		let diffHunks: DiffHunk[] = [];

		if (this.change instanceof InMemFileChange) {
			diffHunks = this.change.diffHunks;
		} else if (this.status !== GitChangeType.RENAME) {
			try {
				const commit = this.sha ?? this.pullRequest.head.sha;
				const patch = await this.pullRequestManager.repository.diffBetween(this.pullRequest.base.sha, commit, this.change.fileName);
				diffHunks = parsePatch(patch);
			} catch (e) {
				Logger.appendLine(`Failed to parse patch for outdated comments: ${e}`);
			}
		}
		return diffHunks;
	}

	constructor(
		public readonly parent: TreeNodeParent,
		protected readonly pullRequestManager: FolderRepositoryManager,
		public readonly pullRequest: PullRequestModel & IResolvedPullRequestModel,
		protected readonly change: SimpleFileChange,
		public readonly filePath: vscode.Uri,
		public readonly parentFilePath: vscode.Uri,
		public readonly sha?: string,
	) {
		super();
		const viewed = this.pullRequest.fileChangeViewedState[this.fileName] ?? ViewedState.UNVIEWED;
		this.contextValue = `${FILECHANGE_FILE_SCHEME}:${GitChangeType[this.status]}:${viewed === ViewedState.VIEWED ? 'viewed' : 'unviewed'
			}`;
		this.label = path.basename(this.fileName);
		this.iconPath = vscode.ThemeIcon.File;
		this.opts = {
			preserveFocus: true,
		};
		this.updateShowOptions();
		this.fileChangeResourceUri = toResourceUri(
			vscode.Uri.file(this.fileName),
			this.pullRequest.number,
			this.fileName,
			this.status,
		);
		this.updateViewed(viewed);

		this.childrenDisposables.push(
			this.pullRequest.onDidChangeReviewThreads(e => {
				if ([...e.added, ...e.removed].some(thread => thread.path === this.fileName)) {
					this.updateShowOptions();
				}
			}),
		);

		this.childrenDisposables.push(
			this.pullRequest.onDidChangeFileViewedState(e => {
				const matchingChange = e.changed.find(viewStateChange => viewStateChange.fileName === this.fileName);
				if (matchingChange) {
					this.updateViewed(matchingChange.viewed);
					this.refresh(this);
				}
			}),
		);


		this.accessibilityInformation = { label: `View diffs and comments for file ${this.label}`, role: 'link' };
	}

	get resourceUri(): vscode.Uri {
		return this.filePath.with({ query: this.fileChangeResourceUri.query });
	}

	get description(): string | true {
		const layout = vscode.workspace.getConfiguration(SETTINGS_NAMESPACE).get<string>(FILE_LIST_LAYOUT);
		if (layout === 'flat') {
			return true;
		} else {
			return '';
		}
	}

	updateViewed(viewed: ViewedState) {
		if (this._viewed === viewed) {
			return;
		}

		this._viewed = viewed;
		this.contextValue = `${FILECHANGE_FILE_SCHEME}:${GitChangeType[this.status]}:${viewed === ViewedState.VIEWED ? 'viewed' : 'unviewed'
			}`;
	}

	updateShowOptions() {
		const reviewThreads = this.pullRequest.reviewThreadsCache;
		const reviewThreadsByFile = groupBy(reviewThreads, thread => thread.path);
		const reviewThreadsForNode = (reviewThreadsByFile[this.fileName] || []).filter(thread => !thread.isOutdated);

		DecorationProvider.updateFileComments(
			this.fileChangeResourceUri,
			this.pullRequest.number,
			this.fileName,
			reviewThreadsForNode.length > 0,
		);

		if (reviewThreadsForNode.length) {
			reviewThreadsForNode.sort((a, b) => a.line - b.line);
			this.opts.selection = new vscode.Range(reviewThreadsForNode[0].line, 0, reviewThreadsForNode[0].line, 0);
		} else {
			delete this.opts.selection;
		}
	}

	getTreeItem(): vscode.TreeItem {
		return this;
	}

	openFileCommand(): vscode.Command {
		return openFileCommand(this.filePath);
	}

	async openDiff(folderManager: FolderRepositoryManager, opts?: vscode.TextDocumentShowOptions): Promise<void> {
		const command = await openDiffCommand(
			folderManager,
			this.parentFilePath,
			this.filePath,
			{
				...this.opts,
				...opts,
			},
			this.status,
		);
		vscode.commands.executeCommand(command.command, ...(command.arguments ?? []));
	}
}

/**
 * File change node whose content is stored in memory and resolved when being revealed.
 */
export class InMemFileChangeNode extends FileChangeNode implements vscode.TreeItem {
	constructor(
		private readonly folderRepositoryManager: FolderRepositoryManager,
		public readonly parent: TreeNodeParent,
		public readonly pullRequest: PullRequestModel & IResolvedPullRequestModel,
		change: SimpleFileChange,
		public readonly previousFileName: string | undefined,
		public readonly filePath: vscode.Uri,
		public readonly parentFilePath: vscode.Uri,
		public isPartial: boolean,
		public readonly patch: string,
		public readonly sha?: string,
	) {
		super(parent, folderRepositoryManager, pullRequest, change, filePath, parentFilePath, sha);
	}

	get comments(): IComment[] {
		return this.pullRequest.comments.filter(comment => (comment.path === this.change.fileName) && (comment.position !== null));
	}

	getTreeItem(): vscode.TreeItem {
		return this;
	}

	async resolve(): Promise<void> {
		this.command = await openDiffCommand(
			this.folderRepositoryManager,
			this.parentFilePath,
			this.filePath,
			undefined,
			this.status,
		);
	}
}

/**
 * File change node whose content can be resolved by git commit sha.
 */
export class GitFileChangeNode extends FileChangeNode implements vscode.TreeItem {
	constructor(
		public readonly parent: TreeNodeParent,
		pullRequestManager: FolderRepositoryManager,
		public readonly pullRequest: PullRequestModel & IResolvedPullRequestModel,
		change: SimpleFileChange,
		public readonly filePath: vscode.Uri,
		public readonly parentFilePath: vscode.Uri,
		public readonly sha?: string,
		private isCurrent?: boolean,
		private _comments?: IComment[]
	) {
		super(parent, pullRequestManager, pullRequest, change, filePath, parentFilePath, sha);
	}

	get comments(): IComment[] {
		if (this._comments) {
			return this._comments;
		}
		// if there's a commit sha, then the comment must belong to the commit.
		return this.pullRequest.comments.filter(comment => {
			if (!this.sha || this.sha === this.pullRequest.head.sha) {
				return comment.position && (comment.path === this.change.fileName);
			} else {
				return (comment.path === this.change.fileName) && (comment.originalCommitId === this.sha);
			}
		});
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
				}),
			});

			return {
				command: 'vscode.diff',
				arguments:
					this.status === GitChangeType.DELETE
						? [this.parentFilePath, emptyFileUri, `${this.fileName}`, { preserveFocus: true }]
						: [emptyFileUri, this.parentFilePath, `${this.fileName}`, { preserveFocus: true }],
				title: 'Open Diff',
			};
		}

		// Show the file change in a diff view.
		const { path: filePath, ref, commit, rootPath } = fromReviewUri(this.filePath.query);
		const previousCommit = `${commit}^`;
		const query: ReviewUriParams = {
			path: filePath,
			ref: ref,
			commit: previousCommit,
			base: true,
			isOutdated: true,
			rootPath,
		};
		const previousFileUri = this.filePath.with({ query: JSON.stringify(query) });
		let currentFilePath = this.filePath;
		// If the commit is the most recent/current commit, then we just use the current file for the right.
		// This is so that comments display properly.
		if (this.isCurrent) {
			currentFilePath = this.pullRequestManager.repository.rootUri.with({ path: path.posix.join(query.rootPath, query.path) });
		}

		const options: vscode.TextDocumentShowOptions = {
			preserveFocus: true,
		};

		const reviewThreads = this.pullRequest.reviewThreadsCache;
		const reviewThreadsByFile = groupBy(reviewThreads, t => t.path);
		const reviewThreadsForNode = (reviewThreadsByFile[this.fileName] || [])
			.filter(thread => thread.isOutdated)
			.sort((a, b) => a.line - b.line);

		if (reviewThreadsForNode.length) {
			options.selection = new vscode.Range(reviewThreadsForNode[0].originalLine, 0, reviewThreadsForNode[0].originalLine, 0);
		}

		return {
			command: 'vscode.diff',
			arguments: [
				previousFileUri,
				currentFilePath,
				`${this.fileName} from ${(commit || '').substr(0, 8)}`,
				options,
			],
			title: 'View Changes',
		};
	}

	async resolve(): Promise<void> {
		if (this._useViewChangesCommand) {
			this.command = await this.alternateCommand();
		} else {
			const openDiff = vscode.workspace.getConfiguration().get('git.openDiffOnClick', true);
			if (openDiff) {
				this.command = await openDiffCommand(
					this.pullRequestManager,
					this.parentFilePath,
					this.filePath,
					this.opts,
					this.status,
				);
			} else {
				this.command = this.openFileCommand();
			}
		}
	}
}

/**
 * File change node whose content is resolved from GitHub. For files not yet associated with a pull request.
 */
export class GitHubFileChangeNode extends TreeNode implements vscode.TreeItem {
	public description: string;
	public iconPath: vscode.ThemeIcon;
	public fileChangeResourceUri: vscode.Uri;

	public command: vscode.Command;

	constructor(
		public readonly parent: TreeNodeParent,
		public readonly fileName: string,
		public readonly previousFileName: string | undefined,
		public readonly status: GitChangeType,
		public readonly baseBranch: string,
		public readonly headBranch: string,
	) {
		super();
		this.label = fileName;
		this.iconPath = vscode.ThemeIcon.File;
		this.fileChangeResourceUri = vscode.Uri.file(fileName).with({
			scheme: GITHUB_FILE_SCHEME,
			query: JSON.stringify({ status, fileName }),
		});

		let parentURI = vscode.Uri.file(fileName).with({
			scheme: GITHUB_FILE_SCHEME,
			query: JSON.stringify({ fileName, branch: baseBranch }),
		});
		let headURI = vscode.Uri.file(fileName).with({
			scheme: GITHUB_FILE_SCHEME,
			query: JSON.stringify({ fileName, branch: headBranch }),
		});
		switch (status) {
			case GitChangeType.ADD:
				parentURI = vscode.Uri.file(fileName).with({
					scheme: GITHUB_FILE_SCHEME,
					query: JSON.stringify({ fileName, branch: baseBranch, isEmpty: true }),
				});
				break;

			case GitChangeType.RENAME:
				parentURI = vscode.Uri.file(previousFileName!).with({
					scheme: GITHUB_FILE_SCHEME,
					query: JSON.stringify({ fileName: previousFileName, branch: baseBranch, isEmpty: true }),
				});
				break;

			case GitChangeType.DELETE:
				headURI = vscode.Uri.file(fileName).with({
					scheme: GITHUB_FILE_SCHEME,
					query: JSON.stringify({ fileName, branch: headBranch, isEmpty: true }),
				});
				break;
		}

		this.command = {
			title: 'Open Diff',
			command: 'vscode.diff',
			arguments: [parentURI, headURI, `${fileName} (Pull Request Preview)`],
		};
	}

	get resourceUri(): vscode.Uri {
		return vscode.Uri.file(this.fileName).with({ query: this.fileChangeResourceUri.query });
	}

	getTreeItem() {
		return this;
	}
}

export function gitFileChangeNodeFilter(nodes: (GitFileChangeNode | RemoteFileChangeNode)[]): GitFileChangeNode[] {
	return nodes.filter(node => node instanceof GitFileChangeNode) as GitFileChangeNode[];
}
