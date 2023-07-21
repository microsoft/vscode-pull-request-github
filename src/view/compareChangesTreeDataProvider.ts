/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as pathLib from 'path';
import * as vscode from 'vscode';
import { Change, Repository } from '../api/api';
import { Status } from '../api/api1';
import { getGitChangeType } from '../common/diffHunk';
import { GitChangeType } from '../common/file';
import Logger from '../common/logger';
import { Schemes } from '../common/uri';
import { dateFromNow, toDisposable } from '../common/utils';
import { OctokitCommon } from '../github/common';
import { FolderRepositoryManager } from '../github/folderRepositoryManager';
import { GitHubRepository } from '../github/githubRepository';
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

class CountNode extends TreeNode {
	getTreeItem(): vscode.TreeItem | Promise<vscode.TreeItem> {
		return {
			label: this.children.length > 1 ? vscode.l10n.t(this.multipleTemplate, this.children.length) : vscode.l10n.t(this.singleTemplate),
			collapsibleState: vscode.TreeItemCollapsibleState.Expanded
		};
	}
	constructor(private readonly singleTemplate: string, private readonly multipleTemplate: string, protected readonly children: TreeNode[]) {
		super();
	}

	async getChildren(): Promise<TreeNode[]> {
		return this.children;
	}
}

class CommitNode extends TreeNode {
	getTreeItem(): vscode.TreeItem | Promise<vscode.TreeItem> {
		return {
			label: this.commit.message,
			description: this.commit.author?.date ? dateFromNow(new Date(this.commit.author.date)) : undefined,
			iconPath: new vscode.ThemeIcon('git-commit'),
		};
	}
	constructor(private readonly commit: OctokitCommon.CompareCommits['commits'][0]['commit']) {
		super();
	}
}

export class CompareChangesTreeProvider implements vscode.TreeDataProvider<TreeNode> {
	private _view: vscode.TreeView<TreeNode>;

	private _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private _gitHubcontentProvider: GitHubContentProvider | undefined;
	private _gitcontentProvider: GitContentProvider | undefined;

	private _disposables: vscode.Disposable[] = [];

	private _gitHubRepository: GitHubRepository | undefined;

	get view(): vscode.TreeView<TreeNode> {
		return this._view;
	}

	constructor(
		private readonly repository: Repository,
		private baseOwner: string,
		private baseBranchName: string,
		private _compareOwner: string,
		private compareBranchName: string,
		private compareHasUpstream: boolean,
		private folderRepoManager: FolderRepositoryManager,
	) {
		this._view = vscode.window.createTreeView('github:compareChanges', {
			treeDataProvider: this,
		});

		this._gitHubRepository = this.folderRepoManager.gitHubRepositories.find(
			repo => repo.remote.owner === this._compareOwner,
		);

		this._disposables.push(this._view);
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

	get compareOwner(): string {
		return this._compareOwner;
	}

	set compareOwner(owner: string) {
		if (this._compareOwner !== owner) {
			this._gitHubRepository = this.folderRepoManager.gitHubRepositories.find(repo => repo.remote.owner === owner);

			if (this._gitHubcontentProvider && this._gitHubRepository) {
				this._gitHubcontentProvider.gitHubRepository = this._gitHubRepository;
			}

			this._compareOwner = owner;
			this._onDidChangeTreeData.fire();
		}
	}

	getTreeItem(element: TreeNode): vscode.TreeItem | Thenable<vscode.TreeItem> {
		return element.getTreeItem();
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

	private async getGitHubFileChildren(files: OctokitCommon.CompareCommits['files'], mergeBase: string) {
		return files.map(file => {
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

	private async getGitHubCommitsChildren(commits: OctokitCommon.CompareCommits['commits']): Promise<TreeNode[]> {
		return commits.map(commit => {
			return new CommitNode(commit.commit);
		});
	}

	private async getGitHubChildren(gitHubRepository: GitHubRepository, element?: TreeNode) {
		if (element) {
			return element.getChildren();
		}

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
			this._view.message = `There are no commits between the base '${this.baseBranchName}' branch and the comparing '${this.compareBranchName}' branch`;
			return [];
		} else if (this._isDisposed) {
			return [];
		} else {
			this._view.message = undefined;
		}

		const files = await this.getGitHubFileChildren(rawFiles, data.merge_base_commit.sha);
		const commits = await this.getGitHubCommitsChildren(rawCommits);
		return [new CountNode('1 commit', '{0} commits', commits), new CountNode('1 file changed', '{0} files changed', files)];
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

	private async getGitChildren(element?: TreeNode) {
		if (!element) {
			const diff = await this.folderRepoManager.repository.diffBetween(this.baseBranchName, this.compareBranchName);
			if (diff.length === 0) {
				this._view.message = `There are no commits between the base '${this.baseBranchName}' branch and the comparing '${this.compareBranchName}' branch`;
				return [];
			} else if (!this.compareHasUpstream) {
				this._view.message = vscode.l10n.t('Branch {0} has not been pushed yet. Showing local changes.', this.compareBranchName);
			} else if (this._isDisposed) {
				return [];
			} else {
				this._view.message = undefined;
			}

			return this.getGitFileChildren(diff);
		} else {
			return element.getChildren();
		}

	}

	async getChildren(element?: TreeNode) {
		if (!this._gitHubRepository) {
			return [];
		}

		this.initialize();

		// Example tree (only when there's an upstream compare branch, when there isn't we just show files)
		// 2 commits
		//   First commit
		//   Second commit
		// 2 changed files
		//   file1
		//   file2

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

	private _isDisposed: boolean = false;
	dispose() {
		this._isDisposed = true;
		this._disposables.forEach(d => d.dispose());
		this._gitHubcontentProvider = undefined;
		this._gitcontentProvider = undefined;
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


