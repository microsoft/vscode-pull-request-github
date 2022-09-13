/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Repository } from '../../api/api';
import { getCommentingRanges } from '../../common/commentingRanges';
import { InMemFileChange, SlimFileChange } from '../../common/file';
import Logger from '../../common/logger';
import { FILE_LIST_LAYOUT } from '../../common/settingKeys';
import { createPRNodeUri, fromPRUri, Schemes } from '../../common/uri';
import { FolderRepositoryManager, SETTINGS_NAMESPACE } from '../../github/folderRepositoryManager';
import { NotificationProvider } from '../../github/notifications';
import { IResolvedPullRequestModel, PullRequestModel } from '../../github/pullRequestModel';
import { InMemFileChangeModel, RemoteFileChangeModel } from '../fileChangeModel';
import { getInMemPRFileSystemProvider, provideDocumentContentForChangeModel } from '../inMemPRContentProvider';
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

	public get repository(): Repository {
		return this._folderReposManager.repository;
	}

	constructor(
		public parent: TreeNodeParent,
		private _folderReposManager: FolderRepositoryManager,
		public pullRequestModel: PullRequestModel,
		private _isLocal: boolean,
		private _notificationProvider: NotificationProvider
	) {
		super();
		this.registerSinceReviewChange();
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
				this.repository
			);

			if (!this.pullRequestModel.isResolved()) {
				return [descriptionNode];
			}

			[, , this._fileChanges, ,] = await Promise.all([
				this.pullRequestModel.initializeReviewThreadCache(),
				this.pullRequestModel.initializePullRequestFileViewState(),
				this.resolveFileChangeNodes(),
				(!this._commentController) ? this.resolvePRCommentController() : new Promise(() => { return; }),
				this.pullRequestModel.validateDraftMode()
			]);

			if (!this._inMemPRContentProvider) {
				this._inMemPRContentProvider = getInMemPRFileSystemProvider()?.registerTextDocumentContentProvider(
					this.pullRequestModel.number,
					this.provideDocumentContent.bind(this),
				);
			}

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

			if (this.pullRequestModel.showChangesSinceReview !== undefined) {
				this.reopenNewPrDiffs(this.pullRequestModel);
			}

			this.childrenDisposables = result;
			return result;
		} catch (e) {
			Logger.appendLine(e);
			return [];
		}
	}

	protected registerSinceReviewChange() {
		this._disposables.push(
			this.pullRequestModel.onDidChangeChangesSinceReview(_ => {
				if (!this.pullRequestModel.isActive) {
					this.refresh();
				}
			})
		);
	}

	public async reopenNewPrDiffs(pullRequest: PullRequestModel) {
		let hasOpenDiff: boolean = false;
		vscode.window.tabGroups.all.map(tabGroup => {
			tabGroup.tabs.map(tab => {
				if (
					tab.input instanceof vscode.TabInputTextDiff &&
					tab.input.original.scheme === Schemes.Pr &&
					tab.input.modified.scheme === Schemes.Pr &&
					this._fileChanges
				) {
					for (const localChange of this._fileChanges) {

						const originalParams = fromPRUri(tab.input.original);
						const modifiedParams = fromPRUri(tab.input.modified);
						if (
							originalParams?.prNumber === pullRequest.number &&
							modifiedParams?.prNumber === pullRequest.number &&
							localChange.fileName === modifiedParams.fileName
						) {
							hasOpenDiff = true;
							vscode.window.tabGroups.close(tab).then(_ => localChange.openDiff(this._folderReposManager, { preview: tab.isPreview }));
							break;
						}
					}
				}
			});
		});
		if (pullRequest.showChangesSinceReview && !hasOpenDiff && this._fileChanges && this._fileChanges.length && !pullRequest.isActive) {
			this._fileChanges[0].openDiff(this._folderReposManager, { preview: true });
		}
	}

	private async resolvePRCommentController(): Promise<void> {
		// If the current branch is this PR's branch, then we can rely on the review comment controller instead.
		if (this.pullRequestModel.equals(this._folderReposManager.activePullRequest)) {
			return;
		}

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

	public async getFileChanges(noCache: boolean | void): Promise<(RemoteFileChangeNode | InMemFileChangeNode)[]> {
		if (!this._fileChanges || noCache) {
			this._fileChanges = await this.resolveFileChangeNodes();
		}

		return this._fileChanges;
	}

	private async resolveFileChangeNodes(): Promise<(RemoteFileChangeNode | InMemFileChangeNode)[]> {
		if (!this.pullRequestModel.isResolved()) {
			return [];
		}

		// If this PR is the the current PR, then we should be careful to use
		// URIs that will cause the review comment controller to be used.
		const rawChanges: (SlimFileChange | InMemFileChange)[] = [];
		const isCurrentPR = this.pullRequestModel.equals(this._folderReposManager.activePullRequest);
		if (isCurrentPR && this._folderReposManager.activePullRequest !== undefined) {
			rawChanges.push(...this._folderReposManager.activePullRequest.fileChanges.values());
		}
		else {
			rawChanges.push(...await this.pullRequestModel.getFileChangesInfo());
		}

		// Merge base is set as part of getFileChangesInfo
		const mergeBase = this.pullRequestModel.mergeBase;
		if (!mergeBase) {
			return [];
		}

		return rawChanges.map(change => {
			if (change instanceof SlimFileChange) {
				const changeModel = new RemoteFileChangeModel(this._folderReposManager, change, this.pullRequestModel);
				return new RemoteFileChangeNode(
					this,
					this._folderReposManager,
					this.pullRequestModel as (PullRequestModel & IResolvedPullRequestModel),
					changeModel
				);
			}

			const changeModel = new InMemFileChangeModel(this._folderReposManager,
				this.pullRequestModel as (PullRequestModel & IResolvedPullRequestModel),
				change, isCurrentPR, mergeBase);
			const changedItem = new InMemFileChangeNode(
				this._folderReposManager,
				this,
				this.pullRequestModel as (PullRequestModel & IResolvedPullRequestModel),
				changeModel
			);

			return changedItem;
		});
	}

	getTreeItem(): vscode.TreeItem {
		const currentBranchIsForThisPR = this.pullRequestModel.equals(this._folderReposManager.activePullRequest);

		const { title, number, author, isDraft, html_url } = this.pullRequestModel;

		const { login } = author;

		const hasNotification = this._notificationProvider.hasNotification(this.pullRequestModel);

		const labelPrefix = currentBranchIsForThisPR ? '✓ ' : '';
		const tooltipPrefix = currentBranchIsForThisPR ? 'Current Branch * ' : '';
		const formattedPRNumber = number.toString();
		const label = `${labelPrefix}#${formattedPRNumber}: ${isDraft ? '[DRAFT] ' : ''}${title}`;
		const tooltip = `${tooltipPrefix}${title} by @${login}`;
		const description = `by @${login}`;

		return {
			label,
			id: `${this.parent instanceof TreeNode ? (this.parent.id ?? this.parent.label) : ''}${html_url}`, // unique id stable across checkout status
			tooltip,
			description,
			collapsibleState: 1,
			contextValue:
				'pullrequest' +
				(this._isLocal ? ':local' : '') +
				(currentBranchIsForThisPR ? ':active' : ':nonactive') +
				(hasNotification ? ':notification' : ''),
			iconPath: this.pullRequestModel.userAvatarUri
				? this.pullRequestModel.userAvatarUri
				: new vscode.ThemeIcon('github'),
			accessibilityInformation: {
				label: `${isDraft ? 'Draft ' : ''}Pull request number ${formattedPRNumber}: ${title} by ${login}`
			},
			resourceUri: createPRNodeUri(this.pullRequestModel),
		};
	}

	async provideCommentingRanges(
		document: vscode.TextDocument,
		_token: vscode.CancellationToken,
	): Promise<vscode.Range[] | undefined> {
		if (document.uri.scheme === Schemes.Pr) {
			const params = fromPRUri(document.uri);

			if (!params || params.prNumber !== this.pullRequestModel.number) {
				return undefined;
			}

			const fileChange = (await this.getFileChanges()).find(change => change.changeModel.fileName === params.fileName);

			if (!fileChange || fileChange instanceof RemoteFileChangeNode) {
				return undefined;
			}

			return getCommentingRanges(await fileChange.changeModel.diffHunks(), params.isBase, PRNode.ID);
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
			contentChange => contentChange.changeModel.fileName === params.fileName,
		)?.changeModel;

		if (!fileChange) {
			Logger.appendLine(`PR> can not find content for document ${uri.toString()}`);
			return '';
		}

		return provideDocumentContentForChangeModel(this._folderReposManager, this.pullRequestModel, params, fileChange);
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
