/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { CategoryTreeNode } from './categoryNode';
import { Repository } from '../../api/api';
import { COPILOT_ACCOUNTS } from '../../common/comment';
import { getCommentingRanges } from '../../common/commentingRanges';
import { InMemFileChange, SlimFileChange } from '../../common/file';
import Logger from '../../common/logger';
import { FILE_LIST_LAYOUT, LIST_HORIZONTAL_SCROLLING, PR_SETTINGS_NAMESPACE, SHOW_PULL_REQUEST_NUMBER_IN_TREE, WORKBENCH } from '../../common/settingKeys';
import { createPRNodeUri, DataUri, fromPRUri, Schemes } from '../../common/uri';
import { FolderRepositoryManager } from '../../github/folderRepositoryManager';
import { CopilotWorkingStatus } from '../../github/githubRepository';
import { IResolvedPullRequestModel, PullRequestModel } from '../../github/pullRequestModel';
import { InMemFileChangeModel, RemoteFileChangeModel } from '../fileChangeModel';
import { getInMemPRFileSystemProvider, provideDocumentContentForChangeModel } from '../inMemPRContentProvider';
import { getIconForeground, getListErrorForeground, getListWarningForeground, getNotebookStatusSuccessIconForeground } from '../theme';
import { DirectoryTreeNode } from './directoryTreeNode';
import { InMemFileChangeNode, RemoteFileChangeNode } from './fileChangeNode';
import { TreeNode, TreeNodeParent } from './treeNode';
import { NotificationsManager } from '../../notifications/notificationsManager';
import { PrsTreeModel } from '../prsTreeModel';

export class PRNode extends TreeNode implements vscode.CommentingRangeProvider2 {
	static ID = 'PRNode';

	private _fileChanges: (RemoteFileChangeNode | InMemFileChangeNode)[] | undefined;
	private _commentController?: vscode.CommentController;

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
		parent: TreeNodeParent,
		private _folderReposManager: FolderRepositoryManager,
		public pullRequestModel: PullRequestModel,
		private _isLocal: boolean,
		private _notificationProvider: NotificationsManager,
		private _prsTreeModel: PrsTreeModel,
	) {
		super(parent);
		this.registerSinceReviewChange();
		this.registerConfigurationChange();
		this._register(this._folderReposManager.onDidChangeActivePullRequest(e => {
			if (e.new?.number === this.pullRequestModel.number || e.old?.number === this.pullRequestModel.number) {
				this.refresh(this);
			}
		}));
		this._register(this._folderReposManager.themeWatcher.onDidChangeTheme(() => {
			this.refresh(this);
		}));
		this.resolvePRCommentController();
	}

	// #region Tree
	override async getChildren(): Promise<TreeNode[]> {
		super.getChildren();
		Logger.debug(`Fetch children of PRNode #${this.pullRequestModel.number}`, PRNode.ID);

		try {
			if (!this.pullRequestModel.isResolved()) {
				return [];
			}

			[, this._fileChanges, ,] = await Promise.all([
				this.pullRequestModel.initializePullRequestFileViewState(),
				this.resolveFileChangeNodes(),
				(!this._commentController) ? this.resolvePRCommentController() : new Promise<void>(resolve => resolve()),
				this.pullRequestModel.validateDraftMode()
			]);

			if (!this._inMemPRContentProvider) {
				this._inMemPRContentProvider = getInMemPRFileSystemProvider()?.registerTextDocumentContentProvider(
					this.pullRequestModel.number,
					this.provideDocumentContent.bind(this),
				);
				if (this._inMemPRContentProvider) {
					this._register(this._inMemPRContentProvider);
				}
			}

			const result: TreeNode[] = [];
			const layout = vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE).get<string>(FILE_LIST_LAYOUT);
			if (layout === 'tree') {
				// tree view
				const dirNode = new DirectoryTreeNode(this, '');
				this._fileChanges.forEach(f => dirNode.addFile(f));
				dirNode.finalize();
				if (dirNode.label === '') {
					// nothing on the root changed, pull children to parent
					result.push(...dirNode._children);
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

			this._children = result;

			// Kick off review thread initialization but don't await it.
			// Events will be fired later that will cause the tree to update when this is ready.
			if (!this.pullRequestModel.reviewThreadsCacheReady) {
				this.pullRequestModel.initializeReviewThreadCache();
			}

			return result;
		} catch (e) {
			Logger.error(`Error getting children ${e}: ${e.message}`, PRNode.ID);
			return [];
		}
	}

	protected registerSinceReviewChange() {
		this._register(this.pullRequestModel.onDidChangeChangesSinceReview(_ => {
			this.refresh(this);
		}));
	}

	protected registerConfigurationChange() {
		this._register(vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(`${PR_SETTINGS_NAMESPACE}.${SHOW_PULL_REQUEST_NUMBER_IN_TREE}`)) {
				this.refresh();
			}
		}));
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
						const newLocalChangeParams = fromPRUri(localChange.changeModel.filePath);
						if (
							originalParams?.prNumber === pullRequest.number &&
							modifiedParams?.prNumber === pullRequest.number &&
							localChange.fileName === modifiedParams.fileName &&
							newLocalChangeParams?.headCommit !== modifiedParams.headCommit
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

		this._register(this.pullRequestModel.githubRepository.commentsHandler!.registerCommentingRangeProvider(
			this.pullRequestModel.number,
			this
		));

		this._register(this.pullRequestModel.githubRepository.commentsHandler!.registerCommentController(
			this.pullRequestModel.number,
			this.pullRequestModel,
			this._folderReposManager,
		));

		this.registerListeners();
	}

	private registerListeners(): void {
		this._register(this.pullRequestModel.onDidChangePendingReviewState(async newDraftMode => {
			if (!newDraftMode) {
				(await this.getFileChanges()).forEach(fileChange => {
					if (fileChange instanceof InMemFileChangeNode) {
						fileChange.comments.forEach(c => (c.isDraft = newDraftMode));
					}
				});
			}
		}));
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
		if (isCurrentPR && (this._folderReposManager.activePullRequest !== undefined) && (this._folderReposManager.activePullRequest.fileChanges.size > 0)) {
			this.pullRequestModel = this._folderReposManager.activePullRequest;
			rawChanges.push(...this._folderReposManager.activePullRequest.fileChanges.values());
		} else {
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

	private async _getAuthorIcon(): Promise<vscode.Uri | vscode.ThemeIcon> {
		// For enterprise, use placeholder icon instead of trying to fetch avatar
		if (!DataUri.isGitHubDotComAvatar(this.pullRequestModel.author.avatarUrl)) {
			return new vscode.ThemeIcon('github');
		}
		return (await DataUri.avatarCirclesAsImageDataUris(this._folderReposManager.context, [this.pullRequestModel.author], 16, 16))[0]
			?? new vscode.ThemeIcon('github');
	}

	private async _getIcon(): Promise<vscode.Uri | vscode.ThemeIcon | { light: vscode.Uri; dark: vscode.Uri }> {
		const copilotWorkingStatus = await this.pullRequestModel.copilotWorkingStatus();
		const theme = this._folderReposManager.themeWatcher.themeData;
		if (copilotWorkingStatus === CopilotWorkingStatus.NotCopilotIssue) {
			return this._getAuthorIcon();
		}
		switch (copilotWorkingStatus) {
			case CopilotWorkingStatus.InProgress:
				return {
					light: DataUri.copilotInProgressAsImageDataURI(getIconForeground(theme, 'light'), getListWarningForeground(theme, 'light')),
					dark: DataUri.copilotInProgressAsImageDataURI(getIconForeground(theme, 'dark'), getListWarningForeground(theme, 'dark'))
				};
			case CopilotWorkingStatus.Done:
				return {
					light: DataUri.copilotSuccessAsImageDataURI(getIconForeground(theme, 'light'), getNotebookStatusSuccessIconForeground(theme, 'light')),
					dark: DataUri.copilotSuccessAsImageDataURI(getIconForeground(theme, 'dark'), getNotebookStatusSuccessIconForeground(theme, 'dark'))
				};
			case CopilotWorkingStatus.Error:
				return {
					light: DataUri.copilotErrorAsImageDataURI(getIconForeground(theme, 'light'), getListErrorForeground(theme, 'light')),
					dark: DataUri.copilotErrorAsImageDataURI(getIconForeground(theme, 'dark'), getListErrorForeground(theme, 'dark'))
				};
			default:
				return this._getAuthorIcon();
		}
	}

	private _getLabel(): string {
		const currentBranchIsForThisPR = this.pullRequestModel.equals(this._folderReposManager.activePullRequest);
		const { title, number, author, isDraft } = this.pullRequestModel;
		let label = '';

		if (currentBranchIsForThisPR) {
			label += '$(check) ';
		}

		if (
			vscode.workspace
				.getConfiguration(PR_SETTINGS_NAMESPACE)
				.get<boolean>(SHOW_PULL_REQUEST_NUMBER_IN_TREE, false)
		) {
			label += `#${number}: `;
		}

		const horizontalScrolling = vscode.workspace.getConfiguration(WORKBENCH).get<boolean>(LIST_HORIZONTAL_SCROLLING, false);
		let labelTitle = (horizontalScrolling && title.length > 50) ? `${title.substring(0, 50)}...` : title;
		if (COPILOT_ACCOUNTS[author.login]) {
			labelTitle = labelTitle.replace('[WIP]', '');
		}
		// Escape any $(...) syntax to avoid rendering PR titles as icons.
		label += labelTitle.replace(/\$\([a-zA-Z0-9~-]+\)/g, '\\$&');

		if (isDraft) {
			label = `_${label}_`;
		}

		return label;
	}

	async getTreeItem(): Promise<vscode.TreeItem> {
		const currentBranchIsForThisPR = this.pullRequestModel.equals(this._folderReposManager.activePullRequest);
		const { title, number, author, isDraft, html_url } = this.pullRequestModel;
		const login = author.specialDisplayName ?? author.login;
		const hasNotification = this._notificationProvider.hasNotification(this.pullRequestModel) || this._prsTreeModel.hasCopilotNotification(this.pullRequestModel.remote.owner, this.pullRequestModel.remote.repositoryName, this.pullRequestModel.number);
		const label: vscode.TreeItemLabel2 = {
			label: new vscode.MarkdownString(this._getLabel(), true)
		};
		const description = `by @${login}`;
		const command = {
			title: vscode.l10n.t('View Pull Request Description'),
			command: 'pr.openDescription',
			arguments: [this],
		};

		return {
			label: label as vscode.TreeItemLabel,
			id: `${this.parent instanceof TreeNode ? (this.parent.id ?? this.parent.label) : ''}${html_url}${this._isLocal ? this.pullRequestModel.localBranchName : ''}`, // unique id stable across checkout status
			description,
			collapsibleState: 1,
			contextValue:
				'pullrequest' +
				(this._isLocal ? ':local' : '') +
				(currentBranchIsForThisPR ? ':active' : ':nonactive') +
				(hasNotification ? ':notification' : '') +
				(((this.pullRequestModel.item.isRemoteHeadDeleted && !this._isLocal) || !this._folderReposManager.isPullRequestAssociatedWithOpenRepository(this.pullRequestModel)) ? '' : ':hasHeadRef'),
			iconPath: await this._getIcon(),
			accessibilityInformation: {
				label: `${isDraft ? 'Draft ' : ''}Pull request number ${number}: ${title} by ${login}`
			},
			resourceUri: createPRNodeUri(this.pullRequestModel, this.parent instanceof CategoryTreeNode && this.parent.isCopilot ? true : undefined),
			command
		};
	}

	async provideCommentingRanges(document: vscode.TextDocument, _token: vscode.CancellationToken): Promise<vscode.Range[] | { enableFileComments: boolean; ranges?: vscode.Range[] } | undefined> {
		if (document.uri.scheme === Schemes.Pr) {
			const params = fromPRUri(document.uri);

			if (!params || params.prNumber !== this.pullRequestModel.number) {
				return undefined;
			}

			const fileChange = (await this.getFileChanges()).find(change => change.changeModel.fileName === params.fileName);

			if (!fileChange || fileChange instanceof RemoteFileChangeNode) {
				return undefined;
			}

			return { ranges: getCommentingRanges(await fileChange.changeModel.diffHunks(), params.isBase, PRNode.ID), enableFileComments: true };
		}

		return undefined;
	}

	// #region Document Content Provider
	private async provideDocumentContent(uri: vscode.Uri): Promise<string | Uint8Array> {
		const params = fromPRUri(uri);
		if (!params) {
			return '';
		}

		const fileChange = (await this.getFileChanges()).find(
			contentChange => contentChange.changeModel.fileName === params.fileName,
		)?.changeModel;

		if (!fileChange) {
			Logger.appendLine(`Can not find content for document ${uri.toString()}`, 'PR');
			return '';
		}

		return provideDocumentContentForChangeModel(this._folderReposManager, this.pullRequestModel, params, fileChange);
	}

	override dispose(): void {
		super.dispose();
		this._commentController = undefined;
	}
}
