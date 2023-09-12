/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as pathLib from 'path';
import * as vscode from 'vscode';
import { Change, Commit, Repository } from '../api/api';
import { Status } from '../api/api1';
import { getGitChangeType } from '../common/diffHunk';
import { GitChangeType } from '../common/file';
import Logger from '../common/logger';
import { GitHubRemote } from '../common/remote';
import { Schemes } from '../common/uri';
import { dateFromNow, toDisposable } from '../common/utils';
import { OctokitCommon } from '../github/common';
import { FolderRepositoryManager } from '../github/folderRepositoryManager';
import { GitHubRepository } from '../github/githubRepository';
import { LoggingOctokit } from '../github/loggingOctokit';
import { GitContentProvider, GitHubContentProvider } from './gitHubContentProvider';
import { GitHubFileChangeNode } from './treeNodes/fileChangeNode';
import { TreeNode } from './treeNodes/treeNode';

export function getGitChangeTypeFromApi(status: Status): GitChangeType {
	switch (status) {
		case Status.DELETED:
			return GitChangeType.DELETE;
		case Status.ADDED_BY_US:
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

	async getChildren(): Promise<TreeNode[]> {
		const { data } = await this.octokit.call(this.octokit.api.repos.compareCommits, {
			repo: this.remote.repositoryName,
			owner: this.remote.owner,
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

	constructor(private readonly commit: OctokitCommon.CompareCommits['commits'][0], private readonly octokit: LoggingOctokit, private readonly remote: GitHubRemote, private readonly parentRef) {
		super();
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

	async getChildren(): Promise<TreeNode[]> {
		const changes = await this.repository.diffBetween(this.parentRef, this.commit.hash);

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

	constructor(private readonly commit: Commit, private readonly repository: Repository, private readonly folderRepoManager: FolderRepositoryManager, private readonly parentRef) {
		super();
	}
}

abstract class CompareChangesTreeProvider implements vscode.TreeDataProvider<TreeNode> {
	private _view: vscode.TreeView<TreeNode>;

	private _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private _disposables: vscode.Disposable[] = [];

	get view(): vscode.TreeView<TreeNode> {
		return this._view;
	}

	set view(view: vscode.TreeView<TreeNode>) {
		this._view = view;
	}

	constructor(
		protected repository: Repository,
		protected baseOwner: string,
		protected baseBranchName: string,
		private _compareOwner: string,
		protected compareBranchName: string,
		protected compareHasUpstream: boolean,
		protected _gitHubRepository: GitHubRepository | undefined
	) {
	}

	updateBaseBranch(branch: string): void {
		if (this.baseBranchName !== branch) {
			this.baseBranchName = branch;
			this._onDidChangeTreeData.fire();
		}
	}

	updateBaseOwner(owner: string) {
		if (this.baseOwner !== owner) {
			this.baseOwner = owner;
			this._onDidChangeTreeData.fire();
		}
	}

	async reveal(treeNode: TreeNode, options?: { select?: boolean; focus?: boolean; expand?: boolean }): Promise<void> {
		return this._view.reveal(treeNode, options);
	}

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	get compareOwner(): string {
		return this._compareOwner;
	}

	set compareOwner(owner: string) {
		this._compareOwner = owner;
	}

	private async updateHasUpstream(branch: string): Promise<boolean> {
		// Currently, the list of selectable compare branches it those on GitHub,
		// plus the current branch which may not be published yet. Check the
		// status of the current branch using local git, otherwise assume it is from
		// GitHub.
		if (this.repository.state.HEAD?.name === branch) {
			const compareBranch = await this.repository.getBranch(branch);
			this.compareHasUpstream = !!compareBranch.upstream;
		} else {
			this.compareHasUpstream = true;
		}
		return this.compareHasUpstream;
	}

	async updateCompareBranch(branch?: string): Promise<void> {
		const oldUpstreamValue = this.compareHasUpstream;
		let changed: boolean = false;
		if (branch) {
			changed = (await this.updateHasUpstream(branch)) !== oldUpstreamValue;
		}
		if (this.compareBranchName !== branch) {
			changed = true;
			if (branch) {
				this.compareBranchName = branch;
			}
		}
		if (changed) {
			this._onDidChangeTreeData.fire();
		}
	}

	getTreeItem(element: TreeNode): vscode.TreeItem | Thenable<vscode.TreeItem> {
		return element.getTreeItem();
	}

	protected async getRawGitHubData(gitHubRepository: GitHubRepository) {
		const { octokit, remote } = await gitHubRepository.ensure();

		const { data } = await octokit.call(octokit.api.repos.compareCommits, {
			repo: remote.repositoryName,
			owner: remote.owner,
			base: `${this.baseOwner}:${this.baseBranchName}`,
			head: `${this.compareOwner}:${this.compareBranchName}`,
		});

		const rawFiles = data.files;
		const rawCommits = data.commits;

		if (!rawFiles?.length || !rawCommits?.length) {
			(this.view as vscode.TreeView2<TreeNode>).message = new vscode.MarkdownString(vscode.l10n.t('There are no commits between the base `{0}` branch and the comparing `{1}` branch', this.baseBranchName, this.compareBranchName));
			return {};
		} else if (this._isDisposed) {
			return {};
		} else {
			this.view.message = undefined;
		}

		return { rawFiles, rawCommits, octokit, remote, mergeBase: data.merge_base_commit.sha };
	}

	protected abstract getGitHubChildren(gitHubRepository: GitHubRepository, element?: TreeNode);

	protected abstract getGitChildren(element?: TreeNode);

	async getChildren(element?: TreeNode) {
		if (!this._gitHubRepository) {
			return [];
		}

		try {
			if (this.compareHasUpstream) {
				return this.getGitHubChildren(this._gitHubRepository, element);
			} else {
				return this.getGitChildren(element);
			}
		} catch (e) {
			Logger.error(`Comparing changes failed: ${e}`);
			return [];
		}
	}

	protected _isDisposed: boolean = false;
	dispose() {
		this._isDisposed = true;
		this._disposables.forEach(d => d.dispose());
		this._view.dispose();
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
		repository: Repository,
		baseOwner: string,
		baseBranchName: string,
		compareOwner: string,
		compareBranchName: string,
		compareHasUpstream: boolean,
		gitHubRepository: GitHubRepository | undefined,
		private folderRepoManager: FolderRepositoryManager,
	) {
		super(repository, baseOwner, baseBranchName, compareOwner, compareBranchName, compareHasUpstream, gitHubRepository);
	}

	protected async getGitHubChildren(gitHubRepository: GitHubRepository, element?: TreeNode) {
		if (element) {
			return element.getChildren();
		}

		const { rawFiles, mergeBase } = await this.getRawGitHubData(gitHubRepository);
		if (rawFiles && mergeBase) {
			return rawFiles.map(file => {
				return new GitHubFileChangeNode(
					this,
					file.filename,
					file.previous_filename,
					getGitChangeType(file.status),
					mergeBase,
					this.compareBranchName,
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
				this.baseBranchName,
				this.compareBranchName,
				true,
			);
		});
	}

	protected async getGitChildren(element?: TreeNode) {
		if (!element) {
			const diff = await this.folderRepoManager.repository.diffBetween(this.baseBranchName, this.compareBranchName);
			if (diff.length === 0) {
				(this.view as vscode.TreeView2<TreeNode>).message = new vscode.MarkdownString(vscode.l10n.t('There are no commits between the base `{0}` branch and the comparing `{1}` branch', this.baseBranchName, this.compareBranchName));
				return [];
			} else if (!this.compareHasUpstream) {
				const message = new vscode.MarkdownString(vscode.l10n.t({ message: 'Branch `{0}` has not been pushed yet. [Publish branch](command:git.publish) to see all changes.', args: [this.compareBranchName], comment: "{Locked='](command:git.publish)'}" }));
				message.isTrusted = { enabledCommands: ['git.publish'] };
				(this.view as vscode.TreeView2<TreeNode>).message = message;
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
		repository: Repository,
		private readonly folderRepoManager: FolderRepositoryManager,
		baseOwner: string,
		baseBranchName: string,
		compareOwner: string,
		compareBranchName: string,
		compareHasUpstream: boolean,
		gitHubRepository: GitHubRepository | undefined,
	) {
		super(repository, baseOwner, baseBranchName, compareOwner, compareBranchName, compareHasUpstream, gitHubRepository);
	}

	protected async getGitHubChildren(gitHubRepository: GitHubRepository, element?: TreeNode) {
		if (element) {
			return element.getChildren();
		}

		const { rawCommits, octokit, remote } = await this.getRawGitHubData(gitHubRepository);
		if (rawCommits && octokit && remote) {
			return rawCommits.map((commit, index) => {
				return new GitHubCommitNode(commit, octokit, remote, index === 0 ? this.baseBranchName : rawCommits[index - 1].sha);
			});
		}
	}

	protected async getGitChildren(element?: TreeNode) {
		if (element) {
			return element.getChildren();
		}

		const log = await this.repository.log({ range: `${this.baseBranchName}..${this.compareBranchName}` });
		if (log.length === 0) {
			(this.view as vscode.TreeView2<TreeNode>).message = new vscode.MarkdownString(vscode.l10n.t('There are no commits between the base `{0}` branch and the comparing `{1}` branch', this.baseBranchName, this.compareBranchName));
			return [];
		} else if (this._isDisposed) {
			return [];
		} else {
			this.view.message = undefined;
		}

		return log.reverse().map((commit, index) => {
			return new GitCommitNode(commit, this.repository, this.folderRepoManager, index === 0 ? this.baseBranchName : log[index - 1].hash);
		});
	}
}

export class CompareChanges implements vscode.Disposable {
	private _filesView: vscode.TreeView<TreeNode>;
	private _filesDataProvider: CompareChangesFilesTreeProvider;
	private _commitsView: vscode.TreeView<TreeNode>;
	private _commitsDataProvider: CompareChangesCommitsTreeProvider;

	private _gitHubcontentProvider: GitHubContentProvider | undefined;
	private _gitcontentProvider: GitContentProvider | undefined;

	private _disposables: vscode.Disposable[] = [];

	private _gitHubRepository: GitHubRepository | undefined;

	constructor(
		repository: Repository,
		baseOwner: string,
		baseBranchName: string,
		compareOwner: string,
		compareBranchName: string,
		compareHasUpstream: boolean,
		private folderRepoManager: FolderRepositoryManager,
	) {
		this._gitHubRepository = this.folderRepoManager.gitHubRepositories.find(
			repo => repo.remote.owner === compareOwner,
		);

		this._filesDataProvider = new CompareChangesFilesTreeProvider(repository, baseOwner, baseBranchName, compareOwner, compareBranchName, compareHasUpstream, this._gitHubRepository, folderRepoManager);
		this._filesView = vscode.window.createTreeView('github:compareChangesFiles', {
			treeDataProvider: this._filesDataProvider
		});
		this._filesDataProvider.view = this._filesView;
		this._commitsDataProvider = new CompareChangesCommitsTreeProvider(repository, folderRepoManager, baseOwner, baseBranchName, compareOwner, compareBranchName, compareHasUpstream, this._gitHubRepository);
		this._commitsView = vscode.window.createTreeView('github:compareChangesCommits', {
			treeDataProvider: this._commitsDataProvider
		});
		this._commitsDataProvider.view = this._commitsView;
		this._disposables.push(this._filesDataProvider);
		this._disposables.push(this._filesView);
		this._disposables.push(this._commitsDataProvider);
		this._disposables.push(this._commitsView);

		this.initialize();
	}

	updateBaseBranch(branch: string): void {
		this._filesDataProvider.updateBaseBranch(branch);
		this._commitsDataProvider.updateBaseBranch(branch);
	}

	updateBaseOwner(owner: string) {
		this._filesDataProvider.updateBaseOwner(owner);
		this._commitsDataProvider.updateBaseOwner(owner);
	}

	async updateCompareBranch(branch?: string): Promise<void> {
		this._filesDataProvider.updateCompareBranch(branch);
		this._commitsDataProvider.updateCompareBranch(branch);
	}

	set compareOwner(owner: string) {
		this._filesDataProvider.compareOwner = owner;
		this._commitsDataProvider.compareOwner = owner;
	}

	private initialize() {
		if (!this._gitHubRepository) {
			return;
		}

		if (!this._gitHubcontentProvider) {
			try {
				this._gitHubcontentProvider = new GitHubContentProvider(this._gitHubRepository);
				this._gitcontentProvider = new GitContentProvider(this.folderRepoManager);
				this._disposables.push(
					vscode.workspace.registerFileSystemProvider(Schemes.GithubPr, this._gitHubcontentProvider, {
						isReadonly: true,
					}),
				);
				this._disposables.push(
					vscode.workspace.registerFileSystemProvider(Schemes.GitPr, this._gitcontentProvider, {
						isReadonly: true,
					}),
				);
				this._disposables.push(toDisposable(() => {
					CompareChangesTreeProvider.closeTabs();
				}));
			} catch (e) {
				// already registered
			}
		}
	}

	dispose() {
		this._disposables.forEach(d => d.dispose());
		this._gitHubcontentProvider = undefined;
		this._gitcontentProvider = undefined;
		this._filesView.dispose();
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


