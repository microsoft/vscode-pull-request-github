/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Branch, Repository } from '../api/api';
import { getGitChangeType } from '../common/diffHunk';
import { fromGitHubURI } from '../common/uri';
import { FolderRepositoryManager } from '../github/folderRepositoryManager';
import { GitHubFileChangeNode } from './treeNodes/fileChangeNode';
import { TreeNode } from './treeNodes/treeNode';

export class CompareChangesTreeProvider implements vscode.TreeDataProvider<TreeNode> {
	private _view: vscode.TreeView<TreeNode>;

	private _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private _contentProvider: GitHubContentProvider;

	private _disposables: vscode.Disposable[] = [];

	constructor(
		public readonly repository: Repository,
		private baseOwner: string,
		public baseBranchName: string,
		public compareBranch: Branch,
		private folderRepoManager: FolderRepositoryManager
	) {
		this._view = vscode.window.createTreeView('github:compareChanges', {
			treeDataProvider: this
		});

		this._disposables.push(this._view);

		this._disposables.push(this.repository.state.onDidChange(async e => {
			// Refresh the compare branch stats if the repo changes
			this.compareBranch = await this.repository.getBranch(this.compareBranch.name!)!;
			this._onDidChangeTreeData.fire();
		}));
	}

	async updateCompareBranch(branch: string): Promise<void> {
		this.compareBranch = await this.repository.getBranch(branch)!;
		this._onDidChangeTreeData.fire();
	}

	updateBaseBranch(branch: string): void {
		this.baseBranchName = branch;
		this._onDidChangeTreeData.fire();
	}

	updateBaseOwner(owner: string): void {
		this.baseOwner = owner;
		this._onDidChangeTreeData.fire();
	}

	getTreeItem(element: TreeNode): vscode.TreeItem | Thenable<vscode.TreeItem> {
		return element.getTreeItem();
	}

	async getChildren() {
		// If no upstream, show error.
		if (!this.compareBranch?.upstream) {
			vscode.commands.executeCommand('setContext', 'github:noUpstream', true);
			this._view.message = undefined;
			return [];
		} else {
			vscode.commands.executeCommand('setContext', 'github:noUpstream', false);
		}

		const upstream = this.compareBranch.upstream!.remote;

		if (!this._contentProvider) {
			this._contentProvider = new GitHubContentProvider(this.folderRepoManager, upstream);
			this._disposables.push(vscode.workspace.registerTextDocumentContentProvider('github', this._contentProvider));
		}

		const githubRepository = this.folderRepoManager.gitHubRepositories.find(repo => repo.remote.remoteName === upstream);
		if (!githubRepository) {
			return [];
		}

		const { octokit, remote } = await githubRepository.ensure();

		const { data } = await octokit.repos.compareCommits({
			repo: remote.repositoryName,
			owner: remote.owner,
			base: `${this.baseOwner}:${this.baseBranchName}`,
			head: `${remote.owner}:${this.compareBranch.name}`,
		});

		if (!data.files.length) {
			this._view.message =
				`The are no commits between the base '${this.baseBranchName}' branch and the comparing '${this.compareBranch.name}' branch`;
		} else {
			this._view.message = undefined;
		}

		return data.files.map(file => {
			// Note: the oktokit typings are slightly incorrect for this data and do not include previous_filename, which is why this cast is here.
			return new GitHubFileChangeNode(this._view, file.filename, (file as any).previous_filename, getGitChangeType(file.status), data.merge_base_commit.sha, this.compareBranch.name!);
		});
	}

	dispose() {
		this._disposables.forEach(d => d.dispose());
	}

}

/**
 * Provides file contents for documents with 'github' scheme. Contents are fetched from GitHub based on
 * information in the document's query string.
 */
class GitHubContentProvider {

	constructor(private folderRepoManager: FolderRepositoryManager, private upstream: string) { }

	async provideTextDocumentContent(uri: vscode.Uri, token: vscode.CancellationToken): Promise<string> {
		const params = fromGitHubURI(uri);
		if (!params || params.isEmpty) {
			return '';
		}

		const githubRepository = this.folderRepoManager.gitHubRepositories.find(repo => repo.remote.remoteName === this.upstream);

		if (!githubRepository) {
			return '';
		}

		const { octokit, remote } = await githubRepository.ensure();
		const fileContent = await octokit.repos.getContent({
			owner: remote.owner,
			repo: remote.repositoryName,
			path: params.fileName,
			ref: params.branch
		});

		const contents = fileContent.data.content ?? '';
		const buff = Buffer.from(contents, <any>fileContent.data.encoding);
		return buff.toString();
	}
}
