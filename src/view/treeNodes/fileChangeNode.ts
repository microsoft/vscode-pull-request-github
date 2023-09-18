/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { IComment, ViewedState } from '../../common/comment';
import { GitChangeType, InMemFileChange } from '../../common/file';
import { FILE_LIST_LAYOUT, GIT, OPEN_DIFF_ON_CLICK, PR_SETTINGS_NAMESPACE } from '../../common/settingKeys';
import { asTempStorageURI, EMPTY_IMAGE_URI, fromReviewUri, ReviewUriParams, Schemes, toResourceUri } from '../../common/uri';
import { groupBy } from '../../common/utils';
import { FolderRepositoryManager } from '../../github/folderRepositoryManager';
import { IResolvedPullRequestModel, PullRequestModel } from '../../github/pullRequestModel';
import { FileChangeModel, GitFileChangeModel, InMemFileChangeModel, RemoteFileChangeModel } from '../fileChangeModel';
import { DecorationProvider } from '../treeDecorationProvider';
import { TreeNode, TreeNodeParent } from './treeNode';

export function openFileCommand(uri: vscode.Uri, inputOpts: vscode.TextDocumentShowOptions = {}): vscode.Command {
	const activeTextEditor = vscode.window.activeTextEditor;
	const opts = {
		...inputOpts, ...{
			viewColumn: vscode.ViewColumn.Active,
		}
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
	let parentURI = (await asTempStorageURI(parentFilePath, folderManager.repository)) || parentFilePath;
	let headURI = (await asTempStorageURI(filePath, folderManager.repository)) || filePath;
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
 * File change node whose content is stored in memory and resolved when being revealed.
 */
export class FileChangeNode extends TreeNode implements vscode.TreeItem2 {
	public iconPath?:
		| string
		| vscode.Uri
		| { light: string | vscode.Uri; dark: string | vscode.Uri }
		| vscode.ThemeIcon;
	public fileChangeResourceUri: vscode.Uri;
	public contextValue: string;
	public command: vscode.Command;
	public opts: vscode.TextDocumentShowOptions;

	public checkboxState: { state: vscode.TreeItemCheckboxState; tooltip?: string; accessibilityInformation: vscode.AccessibilityInformation };

	public childrenDisposables: vscode.Disposable[] = [];

	get status(): GitChangeType {
		return this.changeModel.status;
	}

	get fileName(): string {
		return this.changeModel.fileName;
	}

	get blobUrl(): string | undefined {
		return this.changeModel.blobUrl;
	}

	get sha(): string | undefined {
		return this.changeModel.sha;
	}

	get tooltip(): string {
		return this.resourceUri.fsPath;
	}

	constructor(
		public parent: TreeNodeParent,
		protected readonly pullRequestManager: FolderRepositoryManager,
		public readonly pullRequest: PullRequestModel & IResolvedPullRequestModel,
		public readonly changeModel: FileChangeModel
	) {
		super();
		const viewed = this.pullRequest.fileChangeViewedState[this.changeModel.fileName] ?? ViewedState.UNVIEWED;
		this.contextValue = `${Schemes.FileChange}:${GitChangeType[this.changeModel.status]}:${viewed === ViewedState.VIEWED ? 'viewed' : 'unviewed'
			}`;
		this.label = path.basename(this.changeModel.fileName);
		this.iconPath = vscode.ThemeIcon.File;
		this.opts = {};
		this.updateShowOptions();
		this.fileChangeResourceUri = toResourceUri(
			vscode.Uri.file(this.changeModel.fileName),
			this.pullRequest.number,
			this.changeModel.fileName,
			this.changeModel.status,
			this.changeModel.change instanceof InMemFileChange ? this.changeModel.change.previousFileName : undefined
		);
		this.updateViewed(viewed);

		this.childrenDisposables.push(
			this.pullRequest.onDidChangeReviewThreads(e => {
				if ([...e.added, ...e.removed].some(thread => thread.path === this.changeModel.fileName)) {
					this.updateShowOptions();
				}
			}),
		);

		this.childrenDisposables.push(
			this.pullRequest.onDidChangeFileViewedState(e => {
				const matchingChange = e.changed.find(viewStateChange => viewStateChange.fileName === this.changeModel.fileName);
				if (matchingChange) {
					this.updateViewed(matchingChange.viewed);
					this.refresh(this);
				}
			}),
		);

		this.accessibilityInformation = { label: `View diffs and comments for file ${this.label}`, role: 'link' };
	}

	get resourceUri(): vscode.Uri {
		return this.changeModel.filePath.with({ query: this.fileChangeResourceUri.query });
	}

	get description(): string | true {
		const layout = vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE).get<string>(FILE_LIST_LAYOUT);
		if (layout === 'flat') {
			return true;
		} else {
			return '';
		}
	}

	updateViewed(viewed: ViewedState) {
		this.changeModel.updateViewed(viewed);
		this.contextValue = `${Schemes.FileChange}:${GitChangeType[this.changeModel.status]}:${viewed === ViewedState.VIEWED ? 'viewed' : 'unviewed'
			}`;
		this.checkboxState = viewed === ViewedState.VIEWED ?
			{ state: vscode.TreeItemCheckboxState.Checked, tooltip: vscode.l10n.t('Mark file as unviewed'), accessibilityInformation: { label: vscode.l10n.t('Mark file {0} as unviewed', this.label ?? '') } } :
			{ state: vscode.TreeItemCheckboxState.Unchecked, tooltip: vscode.l10n.t('Mark file as viewed'), accessibilityInformation: { label: vscode.l10n.t('Mark file {0} as viewed', this.label ?? '') } };
	}

	public async markFileAsViewed(fromCheckboxChanged: boolean = true) {
		await this.pullRequest.markFileAsViewed(this.fileName, !fromCheckboxChanged);
		this.pullRequestManager.setFileViewedContext();
	}

	public async unmarkFileAsViewed(fromCheckboxChanged: boolean = true) {
		await this.pullRequest.unmarkFileAsViewed(this.fileName, !fromCheckboxChanged);
		this.pullRequestManager.setFileViewedContext();
	}

	updateFromCheckboxChanged(newState: vscode.TreeItemCheckboxState) {
		const viewed = newState === vscode.TreeItemCheckboxState.Checked ? ViewedState.VIEWED : ViewedState.UNVIEWED;
		this.updateViewed(viewed);

		if (newState === vscode.TreeItemCheckboxState.Checked) {
			this.markFileAsViewed();
		} else {
			this.unmarkFileAsViewed();
		}
	}

	updateShowOptions() {
		const reviewThreads = this.pullRequest.reviewThreadsCache;
		const reviewThreadsByFile = groupBy(reviewThreads, thread => thread.path);
		const reviewThreadsForNode = (reviewThreadsByFile[this.changeModel.fileName] || []).filter(thread => !thread.isOutdated);

		DecorationProvider.updateFileComments(
			this.fileChangeResourceUri,
			this.pullRequest.number,
			this.changeModel.fileName,
			reviewThreadsForNode.length > 0,
		);

		if (reviewThreadsForNode.length) {
			reviewThreadsForNode.sort((a, b) => a.endLine - b.endLine);
			const startLine = reviewThreadsForNode[0].startLine ?? reviewThreadsForNode[0].originalStartLine;
			const endLine = reviewThreadsForNode[0].endLine ?? reviewThreadsForNode[0].originalEndLine;
			this.opts.selection = new vscode.Range(startLine, 0, endLine, 0);
		} else {
			delete this.opts.selection;
		}
	}

	getTreeItem(): vscode.TreeItem {
		return this;
	}

	openFileCommand(): vscode.Command {
		return openFileCommand(this.changeModel.filePath);
	}

	async openDiff(folderManager: FolderRepositoryManager, opts?: vscode.TextDocumentShowOptions): Promise<void> {
		const command = await openDiffCommand(
			folderManager,
			this.changeModel.parentFilePath,
			this.changeModel.filePath,
			{
				...this.opts,
				...opts,
			},
			this.changeModel.status,
		);
		return vscode.commands.executeCommand(command.command, ...(command.arguments ?? []));
	}
}

/**
 * File change node whose content can not be resolved locally and we direct users to GitHub.
 */
export class RemoteFileChangeNode extends FileChangeNode implements vscode.TreeItem {
	get description(): string {
		let description = vscode.workspace.asRelativePath(path.dirname(this.changeModel.fileName), false);
		if (description === '.') {
			description = '';
		}
		return description;
	}

	constructor(
		public parent: TreeNodeParent,
		folderRepositoryManager: FolderRepositoryManager,
		pullRequest: PullRequestModel & IResolvedPullRequestModel,
		changeModel: RemoteFileChangeModel
	) {
		super(parent, folderRepositoryManager, pullRequest, changeModel);
		this.fileChangeResourceUri = toResourceUri(vscode.Uri.parse(changeModel.blobUrl), changeModel.pullRequest.number, changeModel.fileName, changeModel.status, changeModel.previousFileName);
		this.command = {
			command: 'pr.openFileOnGitHub',
			title: 'Open File on GitHub',
			arguments: [this],
		};
	}

	async openDiff(): Promise<void> {
		return vscode.commands.executeCommand(this.command.command);
	}

	openFileCommand(): vscode.Command {
		return this.command;
	}
}

/**
 * File change node whose content is stored in memory and resolved when being revealed.
 */
export class InMemFileChangeNode extends FileChangeNode implements vscode.TreeItem {
	constructor(
		private readonly folderRepositoryManager: FolderRepositoryManager,
		public parent: TreeNodeParent,
		public readonly pullRequest: PullRequestModel & IResolvedPullRequestModel,
		public readonly changeModel: InMemFileChangeModel
	) {
		super(parent, folderRepositoryManager, pullRequest, changeModel);
	}

	get comments(): IComment[] {
		return this.pullRequest.comments.filter(comment => (comment.path === this.changeModel.fileName) && (comment.position !== null));
	}

	getTreeItem(): vscode.TreeItem {
		return this;
	}

	async resolve(): Promise<void> {
		this.command = await openDiffCommand(
			this.folderRepositoryManager,
			this.changeModel.parentFilePath,
			this.changeModel.filePath,
			undefined,
			this.changeModel.status,
		);
	}
}

/**
 * File change node whose content can be resolved by git commit sha.
 */
export class GitFileChangeNode extends FileChangeNode implements vscode.TreeItem {
	constructor(
		public parent: TreeNodeParent,
		pullRequestManager: FolderRepositoryManager,
		public readonly pullRequest: PullRequestModel & IResolvedPullRequestModel,
		public readonly changeModel: GitFileChangeModel,
		private isCurrent?: boolean,
		private _comments?: IComment[]
	) {
		super(parent, pullRequestManager, pullRequest, changeModel);
	}

	get comments(): IComment[] {
		if (this._comments) {
			return this._comments;
		}
		// if there's a commit sha, then the comment must belong to the commit.
		return this.pullRequest.comments.filter(comment => {
			if (!this.sha || this.sha === this.pullRequest.head.sha) {
				return comment.position && (comment.path === this.changeModel.fileName);
			} else {
				return (comment.path === this.changeModel.fileName) && (comment.originalCommitId === this.sha);
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
			const emptyFileUri = this.changeModel.parentFilePath.with({
				query: JSON.stringify({
					path: null,
					commit: null,
				}),
			});

			return {
				command: 'vscode.diff',
				arguments:
					this.status === GitChangeType.DELETE
						? [this.changeModel.parentFilePath, emptyFileUri, `${this.fileName}`, {}]
						: [emptyFileUri, this.changeModel.parentFilePath, `${this.fileName}`, {}],
				title: 'Open Diff',
			};
		}

		// Show the file change in a diff view.
		const { path: filePath, ref, commit, rootPath } = fromReviewUri(this.changeModel.filePath.query);
		const previousCommit = `${commit}^`;
		const query: ReviewUriParams = {
			path: filePath,
			ref: ref,
			commit: previousCommit,
			base: true,
			isOutdated: true,
			rootPath,
		};
		const previousFileUri = this.changeModel.filePath.with({ query: JSON.stringify(query) });
		let currentFilePath = this.changeModel.filePath;
		// If the commit is the most recent/current commit, then we just use the current file for the right.
		// This is so that comments display properly.
		if (this.isCurrent) {
			currentFilePath = this.pullRequestManager.repository.rootUri.with({ path: path.posix.join(query.rootPath, query.path) });
		}

		const options: vscode.TextDocumentShowOptions = {};

		const reviewThreads = this.pullRequest.reviewThreadsCache;
		const reviewThreadsByFile = groupBy(reviewThreads, t => t.path);
		const reviewThreadsForNode = (reviewThreadsByFile[this.fileName] || [])
			.filter(thread => thread.isOutdated)
			.sort((a, b) => a.endLine - b.endLine);

		if (reviewThreadsForNode.length) {
			options.selection = new vscode.Range(reviewThreadsForNode[0].originalStartLine, 0, reviewThreadsForNode[0].originalEndLine, 0);
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
			const openDiff = vscode.workspace.getConfiguration(GIT, this.pullRequestManager.repository.rootUri).get(OPEN_DIFF_ON_CLICK, true);
			if (openDiff) {
				this.command = await openDiffCommand(
					this.pullRequestManager,
					this.changeModel.parentFilePath,
					this.changeModel.filePath,
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
		public readonly isLocal: boolean
	) {
		super();
		const scheme = isLocal ? Schemes.GitPr : Schemes.GithubPr;
		this.label = fileName;
		this.iconPath = vscode.ThemeIcon.File;
		this.fileChangeResourceUri = vscode.Uri.file(fileName).with({
			scheme,
			query: JSON.stringify({ status, fileName }),
		});

		let parentURI = vscode.Uri.file(fileName).with({
			scheme: Schemes.GithubPr,
			query: JSON.stringify({ fileName, branch: baseBranch }),
		});
		let headURI = vscode.Uri.file(fileName).with({
			scheme,
			query: JSON.stringify({ fileName, branch: headBranch }),
		});
		switch (status) {
			case GitChangeType.ADD:
				parentURI = vscode.Uri.file(fileName).with({
					scheme: Schemes.GithubPr,
					query: JSON.stringify({ fileName, branch: baseBranch, isEmpty: true }),
				});
				break;

			case GitChangeType.RENAME:
				parentURI = vscode.Uri.file(previousFileName!).with({
					scheme: Schemes.GithubPr,
					query: JSON.stringify({ fileName: previousFileName, branch: baseBranch, isEmpty: true }),
				});
				break;

			case GitChangeType.DELETE:
				headURI = vscode.Uri.file(fileName).with({
					scheme,
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
