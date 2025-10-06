/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as pathLib from 'path';
import * as vscode from 'vscode';
import { Change, Commit } from '../api/api';
import { Status } from '../api/api1';
import { getGitChangeType } from '../common/diffHunk';
import { GitChangeType } from '../common/file';
import { Disposable, toDisposable } from '../common/lifecycle';
import Logger from '../common/logger';
import { Schemes } from '../common/uri';
import { dateFromNow } from '../common/utils';
import { OctokitCommon } from '../github/common';
import { FolderRepositoryManager } from '../github/folderRepositoryManager';
import { CreatePullRequestDataModel } from './createPullRequestDataModel';
import { GitHubFileChangeNode } from './treeNodes/fileChangeNode';
import { BaseTreeNode, TreeNode, TreeNodeParent } from './treeNodes/treeNode';

export function getGitChangeTypeFromApi(status: Status): GitChangeType {
	switch (status) {
		case Status.DELETED:
			return GitChangeType.DELETE;
		case Status.ADDED_BY_US:
		case Status.INDEX_ADDED:
			return GitChangeType.ADD;
		case Status.INDEX_RENAMED:
			return GitChangeType.RENAME;
		case Status.MODIFIED:
			return GitChangeType.MODIFY;
		default:
			return GitChangeType.UNKNOWN;
	}
}

class GitHubCommitNode extends TreeNode {
	getTreeItem(): vscode.TreeItem | Promise<vscode.TreeItem> {
		return {
			label: this.commit.commit.message,
			description: this.commit.commit.author?.date ? dateFromNow(new Date(this.commit.commit.author.date)) : undefined,
			iconPath: new vscode.ThemeIcon('git-commit'),
			collapsibleState: vscode.TreeItemCollapsibleState.Collapsed
		};
	}

	override async getChildren(): Promise<TreeNode[]> {
		if (!this.model.gitHubRepository) {
			return [];
		}
		const { octokit, remote } = await this.model.gitHubRepository.ensure();
		const { data } = await octokit.call(octokit.api.repos.compareCommits, {
			repo: remote.repositoryName,
			owner: remote.owner,
			base: this.parentRef,
			head: this.commit.sha,
		});

		const rawFiles = data.files;

		if (!rawFiles) {
			return [];
		}
		return rawFiles.map(file => {
			return new GitHubFileChangeNode(
				this,
				file.filename,
				file.previous_filename,
				getGitChangeType(file.status),
				this.parentRef,
				this.commit.sha,
				false,
			);
		});
	}

	constructor(parent: TreeNodeParent, private readonly model: CreatePullRequestDataModel, private readonly commit: OctokitCommon.CompareCommits['commits'][0], private readonly parentRef) {
		super(parent);
	}
}

class GitCommitNode extends TreeNode {
	getTreeItem(): vscode.TreeItem | Promise<vscode.TreeItem> {
		return {
			label: this.commit.message,
			description: this.commit.authorDate ? dateFromNow(new Date(this.commit.authorDate)) : undefined,
			iconPath: new vscode.ThemeIcon('git-commit'),
			collapsibleState: vscode.TreeItemCollapsibleState.Collapsed
		};
	}

	override async getChildren(): Promise<TreeNode[]> {
		const changes = await this.folderRepoManager.repository.diffBetween(this.parentRef, this.commit.hash);

		return changes.map(change => {
			const filename = pathLib.posix.relative(this.folderRepoManager.repository.rootUri.path, change.uri.path);
			const previousFilename = pathLib.posix.relative(this.folderRepoManager.repository.rootUri.path, change.originalUri.path);
			return new GitHubFileChangeNode(
				this,
				filename,
				previousFilename,
				getGitChangeTypeFromApi(change.status),
				this.parentRef,
				this.commit.hash,
				true,
			);
		});
	}

	constructor(parent: TreeNodeParent, private readonly commit: Commit, private readonly folderRepoManager: FolderRepositoryManager, private readonly parentRef) {
		super(parent);
	}
}

abstract class CompareChangesTreeProvider extends Disposable implements vscode.TreeDataProvider<TreeNode>, BaseTreeNode {
	private static readonly ID = 'CompareChangesTreeProvider';
	private _view: vscode.TreeView<TreeNode>;
	private _children: TreeNode[] | undefined;
	private _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	get view(): vscode.TreeView<TreeNode> {
		return this._view;
	}

	set view(view: vscode.TreeView<TreeNode>) {
		this._view = this._register(view);
	}

	constructor(
		protected readonly model: CreatePullRequestDataModel
	) {
		super();
		this._register(model.onDidChange(() => {
			this._onDidChangeTreeData.fire();
		}));
	}

	async reveal(treeNode: TreeNode, options?: { select?: boolean; focus?: boolean; expand?: boolean }): Promise<void> {
		return this._view.reveal(treeNode, options);
	}

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	getTreeItem(element: TreeNode): vscode.TreeItem | Thenable<vscode.TreeItem> {
		return element.getTreeItem();
	}

	protected async getRawGitHubData() {
		try {
			const rawFiles = await this.model.gitHubFiles();
			const rawCommits = await this.model.gitHubCommits();
			const mergeBase = await this.model.gitHubMergeBase();

			if (!rawFiles?.length || !rawCommits?.length) {
				(this.view as vscode.TreeView2<TreeNode>).message = new vscode.MarkdownString(vscode.l10n.t('There are no commits between the base `{0}` branch and the comparing `{1}` branch', this.model.baseBranch, this.model.compareBranch));
				return {};
			} else if (this._isDisposed) {
				return {};
			} else {
				this.view.message = undefined;
			}

			return { rawFiles, rawCommits, mergeBase };
		} catch (e) {
			const eWithName: Partial<{ name: string; status: number }> = e;
			if (e.name && eWithName.name === 'HttpError' && eWithName.status === 404) {
				(this.view as vscode.TreeView2<TreeNode>).message = new vscode.MarkdownString(vscode.l10n.t('The upstream branch `{0}` does not exist on GitHub', this.model.baseBranch));
			}
			return {};
		}
	}

	protected abstract getGitHubChildren(element?: TreeNode): Promise<TreeNode[] | undefined>;

	protected abstract getGitChildren(element?: TreeNode): Promise<TreeNode[] | undefined>;

	get children(): TreeNode[] | undefined {
		return this._children;
	}

	async getChildren(element?: TreeNode) {
		try {
			if (await this.model.getCompareHasUpstream()) {
				this._children = await this.getGitHubChildren(element);
			} else {
				this._children = await this.getGitChildren(element);
			}
		} catch (e) {
			Logger.error(`Comparing changes failed: ${e}`, CompareChangesTreeProvider.ID);
			return [];
		}
		return this._children;
	}

	public static closeTabs() {
		vscode.window.tabGroups.all.forEach(group => group.tabs.forEach(tab => {
			if (tab.input instanceof vscode.TabInputTextDiff) {
				if ((tab.input.modified.scheme === Schemes.GithubPr) || (tab.input.modified.scheme === Schemes.GitPr)) {
					vscode.window.tabGroups.close(tab);
				}
			}
		}));
	}
}

class CompareChangesFilesTreeProvider extends CompareChangesTreeProvider {
	constructor(
		model: CreatePullRequestDataModel,
		private folderRepoManager: FolderRepositoryManager,
	) {
		super(model);
	}

	protected async getGitHubChildren(element?: TreeNode) {
		if (element) {
			return element.getChildren();
		}

		const { rawFiles, mergeBase } = await this.getRawGitHubData();
		if (rawFiles && mergeBase) {
			(this.view as vscode.TreeView2<TreeNode>).message = this.addReviewMessage();
			return rawFiles.map(file => {
				return new GitHubFileChangeNode(
					this,
					file.filename,
					file.previous_filename,
					getGitChangeType(file.status),
					mergeBase,
					this.model.compareBranch,
					false,
				);
			});
		}
	}

	private async getGitFileChildren(diff: Change[]) {
		return diff.map(change => {
			const filename = pathLib.posix.relative(this.folderRepoManager.repository.rootUri.path, change.uri.path);
			const previousFilename = pathLib.posix.relative(this.folderRepoManager.repository.rootUri.path, change.originalUri.path);
			return new GitHubFileChangeNode(
				this,
				filename,
				previousFilename,
				getGitChangeTypeFromApi(change.status),
				this.model.baseBranch,
				this.model.compareBranch,
				true,
			);
		});
	}

	private addReviewMessage(markdown?: vscode.MarkdownString): vscode.MarkdownString | undefined {
		const preReviewer = this.folderRepoManager.getAutoReviewer();
		if (!preReviewer) {
			return markdown;
		}
		if (!markdown) {
			markdown = new vscode.MarkdownString();
		} else {
			markdown.appendMarkdown('\n\n');
		}
		markdown.supportThemeIcons = true;
		markdown.appendMarkdown(`[${vscode.l10n.t('$(sparkle) {0} Code Review', preReviewer.title)}](command:pr.preReview)`);
		return markdown;
	}

	protected async getGitChildren(element?: TreeNode) {
		if (!element) {
			const diff = await this.model.gitFiles();
			if (diff.length === 0) {
				(this.view as vscode.TreeView2<TreeNode>).message = new vscode.MarkdownString(vscode.l10n.t('There are no commits between the base `{0}` branch and the comparing `{1}` branch', this.model.baseBranch, this.model.compareBranch));
				return [];
			} else if (!(await this.model.getCompareHasUpstream())) {
				const message = new vscode.MarkdownString(vscode.l10n.t({ message: 'Branch `{0}` has not been pushed yet. [Publish branch](command:git.publish) to see all changes from base branch.', args: [this.model.compareBranch], comment: "{Locked='](command:git.publish)'}" }));
				message.isTrusted = { enabledCommands: ['git.publish'] };
				(this.view as vscode.TreeView2<TreeNode>).message = this.addReviewMessage(message);
			} else if (this._isDisposed) {
				return [];
			} else {
				this.view.message = undefined;
			}

			return this.getGitFileChildren(diff);
		} else {
			return element.getChildren();
		}

	}
}

class CompareChangesCommitsTreeProvider extends CompareChangesTreeProvider {
	constructor(
		model: CreatePullRequestDataModel,
		private readonly folderRepoManager: FolderRepositoryManager
	) {
		super(model);
	}

	protected async getGitHubChildren(element?: TreeNode) {
		if (element) {
			return element.getChildren();
		}

		const { rawCommits } = await this.getRawGitHubData();
		if (rawCommits) {
			return rawCommits.map((commit, index) => {
				return new GitHubCommitNode(this, this.model, commit, index === 0 ? this.model.baseBranch : rawCommits[index - 1].sha);
			});
		}
	}

	protected async getGitChildren(element?: TreeNode) {
		if (element) {
			return element.getChildren();
		}

		const log = await this.model.gitCommits();
		if (log.length === 0) {
			(this.view as vscode.TreeView2<TreeNode>).message = new vscode.MarkdownString(vscode.l10n.t('There are no commits between the base `{0}` branch and the comparing `{1}` branch', this.model.baseBranch, this.model.compareBranch));
			return [];
		} else if (this._isDisposed) {
			return [];
		} else {
			this.view.message = undefined;
		}

		return log.reverse().map((commit, index) => {
			return new GitCommitNode(this, commit, this.folderRepoManager, index === 0 ? this.model.baseBranch : log[index - 1].hash);
		});
	}
}

export class CompareChanges extends Disposable {
	private readonly _filesView: vscode.TreeView<TreeNode>;
	private readonly _filesDataProvider: CompareChangesFilesTreeProvider;
	private readonly _commitsView: vscode.TreeView<TreeNode>;
	private readonly _commitsDataProvider: CompareChangesCommitsTreeProvider;

	constructor(
		folderRepoManager: FolderRepositoryManager,
		private model: CreatePullRequestDataModel
	) {
		super();
		this._filesDataProvider = this._register(new CompareChangesFilesTreeProvider(model, folderRepoManager));
		this._filesView = this._register(vscode.window.createTreeView('github:compareChangesFiles', {
			treeDataProvider: this._filesDataProvider
		}));
		this._filesDataProvider.view = this._filesView;
		this._commitsDataProvider = this._register(new CompareChangesCommitsTreeProvider(model, folderRepoManager));
		this._commitsView = this._register(vscode.window.createTreeView('github:compareChangesCommits', {
			treeDataProvider: this._commitsDataProvider
		}));
		this._commitsDataProvider.view = this._commitsView;

		this.initialize();
	}

	set compareOwner(owner: string) {
		this.model.compareOwner = owner;
	}

	private initialize() {
		if (!this.model.gitHubRepository) {
			return;
		}

		try {
			this._register(vscode.workspace.registerFileSystemProvider(Schemes.GithubPr, this.model.gitHubContentProvider));
			this._register(vscode.workspace.registerFileSystemProvider(Schemes.GitPr, this.model.gitContentProvider));
			this._register(toDisposable(() => CompareChangesTreeProvider.closeTabs()));
		} catch (e) {
			// already registered
		}

	}

	public static closeTabs() {
		vscode.window.tabGroups.all.forEach(group => group.tabs.forEach(tab => {
			if (tab.input instanceof vscode.TabInputTextDiff) {
				if ((tab.input.modified.scheme === Schemes.GithubPr) || (tab.input.modified.scheme === Schemes.GitPr)) {
					vscode.window.tabGroups.close(tab);
				}
			}
		}));
	}
}


