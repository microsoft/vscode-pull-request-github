/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as pathLib from 'path';
import * as vscode from 'vscode';
import { Commit, Remote, Repository } from '../api/api';
import { GitApiImpl } from '../api/api1';
import { fromReviewUri, Schemes } from '../common/uri';
import { FolderRepositoryManager } from '../github/folderRepositoryManager';
import { RepositoriesManager } from '../github/repositoriesManager';
import { encodeURIComponentExceptSlashes, getBestPossibleUpstream, getOwnerAndRepo, getSimpleUpstream, getUpstreamOrigin, rangeString } from './util';

export class ShareProviderManager implements vscode.Disposable {
	private disposables: vscode.Disposable[] = [];

	constructor(repositoryManager: RepositoriesManager, gitAPI: GitApiImpl) {
		if (!vscode.window.registerShareProvider) {
			return;
		}

		this.disposables.push(
			new GitHubDevShareProvider(repositoryManager, gitAPI),
			new GitHubPermalinkShareProvider(repositoryManager, gitAPI),
			new GitHubPermalinkAsMarkdownShareProvider(repositoryManager, gitAPI),
			new GitHubHeadLinkShareProvider(repositoryManager, gitAPI)
		);
	}

	dispose() {
		this.disposables.forEach((d) => d.dispose());
	}
}

const supportedSchemes = [Schemes.File, Schemes.Review, Schemes.Pr, Schemes.VscodeVfs];

abstract class AbstractShareProvider implements vscode.Disposable, vscode.ShareProvider {
	private disposables: vscode.Disposable[] = [];
	protected shareProviderRegistrations: vscode.Disposable[] | undefined;

	constructor(
		protected repositoryManager: RepositoriesManager,
		protected gitAPI: GitApiImpl,
		public readonly id: string,
		public readonly label: string,
		public readonly priority: number,
		private readonly origin = 'github.com'
	) {
		this.initialize();
	}

	public dispose() {
		this.disposables.forEach((d) => d.dispose());
		this.shareProviderRegistrations?.map((d) => d.dispose());
	}

	private async initialize() {
		if ((await this.hasGitHubRepositories()) && this.shouldRegister()) {
			this.register();
		}

		this.disposables.push(this.repositoryManager.onDidLoadAnyRepositories(async () => {
			if ((await this.hasGitHubRepositories()) && this.shouldRegister()) {
				this.register();
			}
		}));

		this.disposables.push(this.gitAPI.onDidCloseRepository(() => {
			if (!this.hasGitHubRepositories()) {
				this.unregister();
			}
		}));
	}

	private async hasGitHubRepositories() {
		for (const folderManager of this.repositoryManager.folderManagers) {
			if ((await folderManager.computeAllGitHubRemotes()).length) {
				return true;
			}
			return false;
		}
	}

	private register() {
		if (this.shareProviderRegistrations) {
			return;
		}

		this.shareProviderRegistrations = supportedSchemes.map((scheme) => vscode.window.registerShareProvider({ scheme }, this));
	}

	private unregister() {
		this.shareProviderRegistrations?.map((d) => d.dispose());
		this.shareProviderRegistrations = undefined;
	}

	protected abstract shouldRegister(): boolean;
	protected abstract getBlob(folderManager: FolderRepositoryManager, uri: vscode.Uri): Promise<string>;
	protected abstract getUpstream(repository: Repository, commit: string): Promise<Remote | undefined>;

	public async provideShare(item: vscode.ShareableItem): Promise<vscode.Uri | string | undefined> {
		// Get the blob
		const folderManager = this.repositoryManager.getManagerForFile(item.resourceUri);
		if (!folderManager) {
			throw new Error(vscode.l10n.t('Current file does not belong to an open repository.'));
		}
		const blob = await this.getBlob(folderManager, item.resourceUri);

		// Get the upstream
		const repository = folderManager.repository;
		const remote = await this.getUpstream(repository, blob);
		if (!remote || !remote.fetchUrl) {
			throw new Error(vscode.l10n.t('The selection may not exist on any remote.'));
		}

		const origin = getUpstreamOrigin(remote, this.origin).replace(/\/$/, '');
		const path = encodeURIComponentExceptSlashes(item.resourceUri.path.substring(repository.rootUri.path.length));
		const range = getRangeSegment(item);

		return vscode.Uri.parse([
			origin,
			'/',
			getOwnerAndRepo(this.repositoryManager, repository, { ...remote, fetchUrl: remote.fetchUrl }),
			'/blob/',
			blob,
			path,
			range
		].join(''));
	}
}

export class GitHubDevShareProvider extends AbstractShareProvider implements vscode.ShareProvider {
	constructor(repositoryManager: RepositoriesManager, gitApi: GitApiImpl) {
		super(repositoryManager, gitApi, 'githubDevLink', vscode.l10n.t('Copy github.dev Link'), 10, 'github.dev');
	}

	protected shouldRegister(): boolean {
		return vscode.env.appHost === 'github.dev';
	}

	protected async getBlob(folderManager: FolderRepositoryManager): Promise<string> {
		return getHEAD(folderManager);
	}

	protected async getUpstream(repository: Repository): Promise<Remote | undefined> {
		return getSimpleUpstream(repository);
	}
}

export class GitHubPermalinkShareProvider extends AbstractShareProvider implements vscode.ShareProvider {
	constructor(
		repositoryManager: RepositoriesManager,
		gitApi: GitApiImpl,
		id: string = 'githubComPermalink',
		label: string = vscode.l10n.t('Copy GitHub Permalink'),
		priority: number = 11
	) {
		super(repositoryManager, gitApi, id, label, priority);
	}

	protected shouldRegister() {
		return true;
	}

	protected async getBlob(folderManager: FolderRepositoryManager, uri: vscode.Uri): Promise<string> {
		let commit: Commit | undefined;
		let commitHash: string | undefined;
		if (uri.scheme === Schemes.Review) {
			commitHash = fromReviewUri(uri.query).commit;
		}

		if (!commitHash) {
			const repository = folderManager.repository;
			try {
				const log = await repository.log({ maxEntries: 1, path: uri.fsPath });
				if (log.length === 0) {
					throw new Error(vscode.l10n.t('No branch on a remote contains the most recent commit for the file.'));
				}
				// Now that we know that the file existed at some point in the repo, use the head commit to construct the URI.
				if (repository.state.HEAD?.commit && (log[0].hash !== repository.state.HEAD?.commit)) {
					commit = await repository.getCommit(repository.state.HEAD.commit);
				}
				if (!commit) {
					commit = log[0];
				}
				commitHash = commit.hash;
			} catch (e) {
				commitHash = repository.state.HEAD?.commit;
			}
		}

		if (commitHash) {
			return commitHash;
		}

		throw new Error();
	}

	protected async getUpstream(repository: Repository, commit: string): Promise<Remote | undefined> {
		return getBestPossibleUpstream(this.repositoryManager, repository, (await repository.getCommit(commit)).hash);
	}
}

export class GitHubPermalinkAsMarkdownShareProvider extends GitHubPermalinkShareProvider {

	constructor(repositoryManager: RepositoriesManager, gitApi: GitApiImpl) {
		super(repositoryManager, gitApi, 'githubComPermalinkAsMarkdown', vscode.l10n.t('Copy GitHub Permalink as Markdown'), 12);
	}

	async provideShare(item: vscode.ShareableItem): Promise<vscode.Uri | string | undefined> {
		const link = await super.provideShare(item);

		const text = await this.getMarkdownLinkText(item);
		if (link) {
			return `[${text?.trim() ?? ''}](${link.toString()})`;
		}
	}

	private async getMarkdownLinkText(item: vscode.ShareableItem): Promise<string | undefined> {
		const fileName = pathLib.basename(item.resourceUri.path);

		if (item.selection) {
			const document = await vscode.workspace.openTextDocument(item.resourceUri);

			const editorSelection = item.selection.start === item.selection.end
				? item.selection
				: new vscode.Range(item.selection.start, new vscode.Position(item.selection.start.line + 1, 0));

			const selectedText = document.getText(editorSelection);
			if (selectedText) {
				return selectedText;
			}

			const wordRange = document.getWordRangeAtPosition(item.selection.start);
			if (wordRange) {
				return document.getText(wordRange);
			}
		}

		return fileName;
	}
}

export class GitHubHeadLinkShareProvider extends AbstractShareProvider implements vscode.ShareProvider {
	constructor(repositoryManager: RepositoriesManager, gitApi: GitApiImpl) {
		super(repositoryManager, gitApi, 'githubComHeadLink', vscode.l10n.t('Copy GitHub HEAD Link'), 13);
	}

	protected shouldRegister() {
		return true;
	}

	protected async getBlob(folderManager: FolderRepositoryManager): Promise<string> {
		return getHEAD(folderManager);
	}

	protected async getUpstream(repository: Repository): Promise<Remote | undefined> {
		return getSimpleUpstream(repository);
	}
}

function getRangeSegment(item: vscode.ShareableItem): string {
	if (item.resourceUri.scheme === 'vscode-notebook-cell') {
		// Do not return a range or selection fragment for notebooks
		// since github.com and github.dev do not support notebook deeplinks
		return '';
	}

	return rangeString(item.selection);
}

async function getHEAD(folderManager: FolderRepositoryManager) {
	let branchName = folderManager.repository.state.HEAD?.name;
	if (!branchName) {
		// Fall back to default branch name if we are not currently on a branch
		const origin = await folderManager.getOrigin();
		const metadata = await origin.getMetadata();
		branchName = metadata.default_branch;
	}

	return encodeURIComponentExceptSlashes(branchName);
}
