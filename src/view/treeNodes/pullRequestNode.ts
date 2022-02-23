/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { getCommentingRanges } from '../../common/commentingRanges';
import { DiffChangeType, getModifiedContentFromDiffHunk } from '../../common/diffHunk';
import { GitChangeType, SlimFileChange } from '../../common/file';
import Logger from '../../common/logger';
import { FILE_LIST_LAYOUT } from '../../common/settingKeys';
import { fromPRUri, resolvePath, toPRUri } from '../../common/uri';
import { FolderRepositoryManager, SETTINGS_NAMESPACE } from '../../github/folderRepositoryManager';
import { IResolvedPullRequestModel, PullRequestModel } from '../../github/pullRequestModel';
import { getInMemPRFileSystemProvider } from '../inMemPRContentProvider';
import { DescriptionNode } from './descriptionNode';
import { DirectoryTreeNode } from './directoryTreeNode';
import { InMemFileChangeNode, RemoteFileChangeNode } from './fileChangeNode';
import { TreeNode, TreeNodeParent } from './treeNode';

export class PRNode extends TreeNode implements vscode.CommentingRangeProvider {
	static ID = 'PRNode';

	private _fileChanges: (RemoteFileChangeNode | InMemFileChangeNode)[] | undefined;
	private _commentController?: vscode.CommentController;
	private _disposables: vscode.Disposable[] = [];

	private _inMemPRContentProvider?: vscode.Disposable;

	private _command: vscode.Command;

	public get command(): vscode.Command {
		return this._command;
	}

	public set command(newCommand: vscode.Command) {
		this._command = newCommand;
	}

	constructor(
		public parent: TreeNodeParent,
		private _folderReposManager: FolderRepositoryManager,
		public pullRequestModel: PullRequestModel,
		private _isLocal: boolean,
	) {
		super();
	}

	// #region Tree
	async getChildren(): Promise<TreeNode[]> {
		Logger.debug(`Fetch children of PRNode #${this.pullRequestModel.number}`, PRNode.ID);
		this.pullRequestModel.onDidInvalidate(() => this.refresh(this));

		try {
			if (this.childrenDisposables && this.childrenDisposables.length) {
				this.childrenDisposables.forEach(dp => dp.dispose());
				this.childrenDisposables = [];
			}

			const descriptionNode = new DescriptionNode(
				this,
				'Description',
				new vscode.ThemeIcon('git-pull-request'),
				this.pullRequestModel,
			);

			if (!this.pullRequestModel.isResolved()) {
				return [descriptionNode];
			}

			await this.pullRequestModel.initializeReviewThreadCache();
			await this.pullRequestModel.initializePullRequestFileViewState();
			this._fileChanges = await this.resolveFileChanges();

			if (!this._inMemPRContentProvider) {
				this._inMemPRContentProvider = getInMemPRFileSystemProvider().registerTextDocumentContentProvider(
					this.pullRequestModel.number,
					this.provideDocumentContent.bind(this),
				);
			}

			if (!this._commentController) {
				await this.resolvePRCommentController();
			}

			await this.pullRequestModel.validateDraftMode();

			const result: TreeNode[] = [descriptionNode];
			const layout = vscode.workspace.getConfiguration(SETTINGS_NAMESPACE).get<string>(FILE_LIST_LAYOUT);
			if (layout === 'tree') {
				// tree view
				const dirNode = new DirectoryTreeNode(this, '');
				this._fileChanges.forEach(f => dirNode.addFile(f));
				dirNode.finalize();
				if (dirNode.label === '') {
					// nothing on the root changed, pull children to parent
					result.push(...dirNode.children);
				} else {
					result.push(dirNode);
				}
			} else {
				// flat view
				result.push(...this._fileChanges);
			}

			this.childrenDisposables = result;
			return result;
		} catch (e) {
			Logger.appendLine(e);
			return [];
		}
	}

	private async resolvePRCommentController(): Promise<void> {
		await this.pullRequestModel.githubRepository.ensureCommentsController();
		this._commentController = this.pullRequestModel.githubRepository.commentsController!;

		this._disposables.push(
			this.pullRequestModel.githubRepository.commentsHandler!.registerCommentingRangeProvider(
				this.pullRequestModel.number,
				this,
			),
		);

		this._disposables.push(
			this.pullRequestModel.githubRepository.commentsHandler!.registerCommentController(
				this.pullRequestModel.number,
				this.pullRequestModel,
				this._folderReposManager,
			),
		);

		this.registerListeners();
	}

	private registerListeners(): void {
		this._disposables.push(
			this.pullRequestModel.onDidChangePendingReviewState(async newDraftMode => {
				if (!newDraftMode) {
					(await this.getFileChanges()).forEach(fileChange => {
						if (fileChange instanceof InMemFileChangeNode) {
							fileChange.comments.forEach(c => (c.isDraft = newDraftMode));
						}
					});
				}
			}),
		);
	}

	private async getFileChanges(): Promise<(RemoteFileChangeNode | InMemFileChangeNode)[]> {
		if (!this._fileChanges) {
			this._fileChanges = await this.resolveFileChanges();
		}

		return this._fileChanges;
	}

	private async resolveFileChanges(): Promise<(RemoteFileChangeNode | InMemFileChangeNode)[]> {
		if (!this.pullRequestModel.isResolved()) {
			return [];
		}

		const rawChanges = await this.pullRequestModel.getFileChangesInfo(this._folderReposManager.repository);

		// Merge base is set as part of getPullRequestFileChangesInfo
		const mergeBase = this.pullRequestModel.mergeBase;
		if (!mergeBase) {
			return [];
		}

		return rawChanges.map(change => {
			const headCommit = this.pullRequestModel.head!.sha;
			const parentFileName = change.status === GitChangeType.RENAME ? change.previousFileName! : change.fileName;
			if (change instanceof SlimFileChange) {
				return new RemoteFileChangeNode(
					this,
					this.pullRequestModel,
					change.status,
					change.fileName,
					change.previousFileName,
					change.blobUrl,
					toPRUri(
						vscode.Uri.file(
							resolvePath(this._folderReposManager.repository.rootUri, change.fileName),
						),
						this.pullRequestModel,
						change.baseCommit,
						headCommit,
						change.fileName,
						false,
						change.status,
					),
					toPRUri(
						vscode.Uri.file(
							resolvePath(this._folderReposManager.repository.rootUri, parentFileName),
						),
						this.pullRequestModel,
						change.baseCommit,
						headCommit,
						change.fileName,
						true,
						change.status,
					),
				);
			}

			const changedItem = new InMemFileChangeNode(
				this._folderReposManager,
				this,
				this.pullRequestModel as (PullRequestModel & IResolvedPullRequestModel),
				change,
				change.previousFileName,
				toPRUri(
					vscode.Uri.file(resolvePath(this._folderReposManager.repository.rootUri, change.fileName)),
					this.pullRequestModel,
					change.baseCommit,
					headCommit,
					change.fileName,
					false,
					change.status,
				),
				toPRUri(
					vscode.Uri.file(resolvePath(this._folderReposManager.repository.rootUri, parentFileName)),
					this.pullRequestModel,
					change.baseCommit,
					headCommit,
					change.fileName,
					true,
					change.status,
				),
				change.isPartial,
				change.patch
			);

			return changedItem;
		});
	}

	getTreeItem(): vscode.TreeItem {
		const currentBranchIsForThisPR = this.pullRequestModel.equals(this._folderReposManager.activePullRequest);

		const { title, number, author, isDraft, html_url } = this.pullRequestModel;

		const { login } = author;

		const labelPrefix = currentBranchIsForThisPR ? '✓ ' : '';
		const tooltipPrefix = currentBranchIsForThisPR ? 'Current Branch * ' : '';
		const formattedPRNumber = number.toString();
		const label = `${labelPrefix}#${formattedPRNumber}: ${isDraft ? '[DRAFT] ' : ''}${title}`;
		const tooltip = `${tooltipPrefix}${title} by @${login}`;
		const description = `by @${login}`;

		return {
			label,
			id: `${this.parent instanceof TreeNode ? this.parent.label : ''}${html_url}`, // unique id stable across checkout status
			tooltip,
			description,
			collapsibleState: 1,
			contextValue:
				'pullrequest' + (this._isLocal ? ':local' : '') + (currentBranchIsForThisPR ? ':active' : ':nonactive'),
			iconPath: this.pullRequestModel.userAvatarUri
				? this.pullRequestModel.userAvatarUri
				: new vscode.ThemeIcon('github'),
			accessibilityInformation: {
				label: `${isDraft ? 'Draft ' : ''}Pull request number ${formattedPRNumber}: ${title} by ${login}`
			}
		};
	}

	async provideCommentingRanges(
		document: vscode.TextDocument,
		_token: vscode.CancellationToken,
	): Promise<vscode.Range[] | undefined> {
		if (document.uri.scheme === 'pr') {
			const params = fromPRUri(document.uri);

			if (!params || params.prNumber !== this.pullRequestModel.number) {
				return undefined;
			}

			const fileChange = (await this.getFileChanges()).find(change => change.fileName === params.fileName);

			if (!fileChange || fileChange instanceof RemoteFileChangeNode) {
				return undefined;
			}

			return getCommentingRanges(await fileChange.diffHunks(), params.isBase);
		}

		return undefined;
	}

	// #region Document Content Provider
	private async provideDocumentContent(uri: vscode.Uri): Promise<string> {
		const params = fromPRUri(uri);
		if (!params) {
			return '';
		}

		const fileChange = (await this.getFileChanges()).find(
			contentChange => contentChange.fileName === params.fileName,
		);
		if (!fileChange) {
			Logger.appendLine(`PR> can not find content for document ${uri.toString()}`);
			return '';
		}

		if (
			(params.isBase && fileChange.status === GitChangeType.ADD) ||
			(!params.isBase && fileChange.status === GitChangeType.DELETE)
		) {
			return '';
		}

		if (fileChange instanceof RemoteFileChangeNode || fileChange.isPartial) {
			try {
				if (params.isBase) {
					return this.pullRequestModel.getFile(
						fileChange.previousFileName || fileChange.fileName,
						params.baseCommit,
					);
				} else {
					return this.pullRequestModel.getFile(fileChange.fileName, params.headCommit);
				}
			} catch (e) {
				Logger.appendLine(`PR> Fetching file content failed: ${e}`);
				vscode.window
					.showWarningMessage(
						'Opening this file locally failed. Would you like to view it on GitHub?',
						'Open on GitHub',
					)
					.then(result => {
						if ((result === 'Open on GitHub') && fileChange.blobUrl) {
							vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(fileChange.blobUrl));
						}
					});
				return '';
			}
		}

		if (fileChange instanceof InMemFileChangeNode) {
			const readContentFromDiffHunk =
				fileChange.status === GitChangeType.ADD || fileChange.status === GitChangeType.DELETE;

			if (readContentFromDiffHunk) {
				if (params.isBase) {
					// left
					const left: string[] = [];
					const diffHunks = await fileChange.diffHunks();
					for (let i = 0; i < diffHunks.length; i++) {
						for (let j = 0; j < diffHunks[i].diffLines.length; j++) {
							const diffLine = diffHunks[i].diffLines[j];
							if (diffLine.type === DiffChangeType.Add) {
								// nothing
							} else if (diffLine.type === DiffChangeType.Delete) {
								left.push(diffLine.text);
							} else if (diffLine.type === DiffChangeType.Control) {
								// nothing
							} else {
								left.push(diffLine.text);
							}
						}
					}

					return left.join('\n');
				} else {
					const right: string[] = [];
					const diffHunks = await fileChange.diffHunks();
					for (let i = 0; i < diffHunks.length; i++) {
						for (let j = 0; j < diffHunks[i].diffLines.length; j++) {
							const diffLine = diffHunks[i].diffLines[j];
							if (diffLine.type === DiffChangeType.Add) {
								right.push(diffLine.text);
							} else if (diffLine.type === DiffChangeType.Delete) {
								// nothing
							} else if (diffLine.type === DiffChangeType.Control) {
								// nothing
							} else {
								right.push(diffLine.text);
							}
						}
					}

					return right.join('\n');
				}
			} else {
				const originalFileName =
					fileChange.status === GitChangeType.RENAME ? fileChange.previousFileName : fileChange.fileName;
				const originalFilePath = vscode.Uri.joinPath(
					this._folderReposManager.repository.rootUri,
					originalFileName!,
				);
				const originalContent = await this._folderReposManager.repository.show(
					params.baseCommit,
					originalFilePath.fsPath,
				);

				if (params.isBase) {
					return originalContent;
				} else {
					return getModifiedContentFromDiffHunk(originalContent, fileChange.patch);
				}
			}
		}

		return '';
	}

	dispose(): void {
		super.dispose();

		if (this._inMemPRContentProvider) {
			this._inMemPRContentProvider.dispose();
		}

		this._commentController = undefined;

		this._disposables.forEach(d => d.dispose());
		this._disposables = [];
	}
}
