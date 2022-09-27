/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as buffer from 'buffer';
import * as vscode from 'vscode';
import { Repository } from '../api/api';
import { getGitChangeType } from '../common/diffHunk';
import Logger from '../common/logger';
import { fromGitHubURI, Schemes } from '../common/uri';
import { FolderRepositoryManager } from '../github/folderRepositoryManager';
import { GitHubRepository } from '../github/githubRepository';
import { ReadonlyFileSystemProvider } from './readonlyFileSystemProvider';
import { GitHubFileChangeNode } from './treeNodes/fileChangeNode';
import { TreeNode } from './treeNodes/treeNode';

export class CompareChangesTreeProvider implements vscode.TreeDataProvider<TreeNode> {
	private _view: vscode.TreeView<TreeNode>;

	private _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private _contentProvider: GitHubContentProvider | undefined;

	private _disposables: vscode.Disposable[] = [];

	private _gitHubRepository: GitHubRepository | undefined;

	get view(): vscode.TreeView<TreeNode> {
		return this._view;
	}

	constructor(
		private readonly repository: Repository,
		private baseOwner: string,
		public baseBranchName: string,
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
		this.baseBranchName = branch;
		this._onDidChangeTreeData.fire();
	}

	updateBaseOwner(owner: string) {
		this.baseOwner = owner;
		this._onDidChangeTreeData.fire();
	}

	async reveal(treeNode: TreeNode, options?: { select?: boolean; focus?: boolean; expand?: boolean }): Promise<void> {
		return this._view.reveal(treeNode, options);
	}

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	private async updateHasUpstream(branch: string): Promise<void> {
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
	}

	async updateCompareBranch(branch?: string): Promise<void> {
		if (branch) {
			await this.updateHasUpstream(branch);
			this.compareBranchName = branch;
		}
		this._onDidChangeTreeData.fire();
	}

	get compareOwner(): string {
		return this._compareOwner;
	}

	set compareOwner(owner: string) {
		this._gitHubRepository = this.folderRepoManager.gitHubRepositories.find(repo => repo.remote.owner === owner);

		if (this._contentProvider && this._gitHubRepository) {
			this._contentProvider.gitHubRepository = this._gitHubRepository;
		}

		this._compareOwner = owner;
		this._onDidChangeTreeData.fire();
	}

	getTreeItem(element: TreeNode): vscode.TreeItem | Thenable<vscode.TreeItem> {
		return element.getTreeItem();
	}

	async getChildren() {
		// If no upstream, show error.
		if (!this.compareHasUpstream) {
			vscode.commands.executeCommand('setContext', 'github:noUpstream', true);
			this._view.message = undefined;
			return [];
		} else {
			vscode.commands.executeCommand('setContext', 'github:noUpstream', false);
		}

		if (!this._gitHubRepository) {
			return [];
		}

		if (!this._contentProvider) {
			this._contentProvider = new GitHubContentProvider(this._gitHubRepository);
			this._disposables.push(
				vscode.workspace.registerFileSystemProvider(Schemes.GithubPr, this._contentProvider, {
					isReadonly: true,
				}),
			);
		}

		const { octokit, remote } = await this._gitHubRepository.ensure();

		try {
			const { data } = await octokit.call(octokit.api.repos.compareCommits, {
				repo: remote.repositoryName,
				owner: remote.owner,
				base: `${this.baseOwner}:${this.baseBranchName}`,
				head: `${this.compareOwner}:${this.compareBranchName}`,
			});

			if (!data.files.length) {
				this._view.message = `There are no commits between the base '${this.baseBranchName}' branch and the comparing '${this.compareBranchName}' branch`;
			} else if (this._isDisposed) {
				return [];
			} else {
				this._view.message = undefined;
			}

			return data.files.map(file => {
				return new GitHubFileChangeNode(
					this,
					file.filename,
					file.previous_filename,
					getGitChangeType(file.status),
					data.merge_base_commit.sha,
					this.compareBranchName,
				);
			});
		} catch (e) {
			Logger.error(`Comparing changes failed: ${e}`);
			return [];
		}
	}

	private _isDisposed: boolean = false;
	dispose() {
		this._isDisposed = true;
		this._disposables.forEach(d => d.dispose());
		this._contentProvider = undefined;
	}
}

/**
 * Provides file contents for documents with GITHUB_FILE_SCHEME (githubpr) scheme. Contents are fetched from GitHub based on
 * information in the document's query string.
 */
class GitHubContentProvider extends ReadonlyFileSystemProvider {
	constructor(public gitHubRepository: GitHubRepository) {
		super();
	}

	async readFile(uri: any): Promise<Uint8Array> {
		const params = fromGitHubURI(uri);
		if (!params || params.isEmpty) {
			return new TextEncoder().encode('');
		}

		const { octokit, remote } = await this.gitHubRepository.ensure();
		let fileContent: { data: { content: string; encoding: string; sha: string } } = (await octokit.call(octokit.api.repos.getContent,
			{
				owner: remote.owner,
				repo: remote.repositoryName,
				path: params.fileName,
				ref: params.branch,
			},
		)) as any;
		let contents = fileContent.data.content ?? '';

		// Empty contents and 'none' encoding indcates that the file has been truncated and we should get the blob.
		if (contents === '' && fileContent.data.encoding === 'none') {
			const fileSha = fileContent.data.sha;
			fileContent = await octokit.call(octokit.api.git.getBlob, {
				owner: remote.owner,
				repo: remote.repositoryName,
				file_sha: fileSha,
			});
			contents = fileContent.data.content;
		}

		const buff = buffer.Buffer.from(contents, (fileContent.data as any).encoding);
		return buff;
	}
}
