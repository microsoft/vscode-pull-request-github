/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { CreateParams, CreatePullRequest, RemoteInfo } from '../../common/views';
import type { Branch } from '../api/api';
import Logger from '../common/logger';
import { Protocol } from '../common/protocol';
import { Remote } from '../common/remote';
import { getNonce, IRequestMessage, WebviewViewBase } from '../common/webview';
import {
	byRemoteName,
	DetachedHeadError,
	FolderRepositoryManager,
	PullRequestDefaults,
	titleAndBodyFrom,
} from './folderRepositoryManager';
import { RepoAccessAndMergeMethods } from './interface';
import { PullRequestModel } from './pullRequestModel';
import { getDefaultMergeMethod } from './pullRequestOverview';

export class CreatePullRequestViewProvider extends WebviewViewBase implements vscode.WebviewViewProvider {
	public readonly viewType = 'github:createPullRequest';

	private _onDone = new vscode.EventEmitter<PullRequestModel | undefined>();
	readonly onDone: vscode.Event<PullRequestModel | undefined> = this._onDone.event;

	private _onDidChangeBaseRemote = new vscode.EventEmitter<RemoteInfo>();
	readonly onDidChangeBaseRemote: vscode.Event<RemoteInfo> = this._onDidChangeBaseRemote.event;

	private _onDidChangeBaseBranch = new vscode.EventEmitter<string>();
	readonly onDidChangeBaseBranch: vscode.Event<string> = this._onDidChangeBaseBranch.event;

	private _onDidChangeCompareRemote = new vscode.EventEmitter<RemoteInfo>();
	readonly onDidChangeCompareRemote: vscode.Event<RemoteInfo> = this._onDidChangeCompareRemote.event;

	private _onDidChangeCompareBranch = new vscode.EventEmitter<string>();
	readonly onDidChangeCompareBranch: vscode.Event<string> = this._onDidChangeCompareBranch.event;

	private _compareBranch: string;
	private _baseBranch: string;

	private _firstLoad: boolean = true;

	constructor(
		extensionUri: vscode.Uri,
		private readonly _folderRepositoryManager: FolderRepositoryManager,
		private readonly _pullRequestDefaults: PullRequestDefaults,
		compareBranch: Branch,
	) {
		super(extensionUri);

		this._defaultCompareBranch = compareBranch;
	}

	public resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken,
	) {
		super.resolveWebviewView(webviewView, _context, _token);
		webviewView.webview.html = this._getHtmlForWebview();

		if (this._firstLoad) {
			this._firstLoad = false;
			// Reset any stored state.
			// TODO @RMacfarlane Clear stored state on extension deactivation instead.
			this.initializeParams(true);
		} else {
			this.initializeParams();
		}
	}

	private _defaultCompareBranch: Branch;
	get defaultCompareBranch() {
		return this._defaultCompareBranch;
	}

	set defaultCompareBranch(compareBranch: Branch | undefined) {
		if (
			compareBranch &&
			(compareBranch?.name !== this._defaultCompareBranch.name ||
				compareBranch?.upstream?.remote !== this._defaultCompareBranch.upstream?.remote)
		) {
			this._defaultCompareBranch = compareBranch;
			void this.initializeParams();
			this._onDidChangeCompareBranch.fire(this._defaultCompareBranch.name!);
		}
	}

	public show(compareBranch?: Branch): void {
		if (compareBranch) {
			this.defaultCompareBranch = compareBranch;
		}

		super.show();
	}

	private async getTotalGitHubCommits(compareBranch: Branch, baseBranchName: string): Promise<number | undefined> {
		const origin = await this._folderRepositoryManager.getOrigin(compareBranch);

		if (compareBranch.upstream) {
			const headRepo = this._folderRepositoryManager.findRepo(byRemoteName(compareBranch.upstream.remote));

			if (headRepo) {
				const headBranch = `${headRepo.remote.owner}:${compareBranch.name ?? ''}`;
				const baseBranch = `${this._pullRequestDefaults.owner}:${baseBranchName}`;
				const { total_commits } = await origin.compareCommits(baseBranch, headBranch);

				return total_commits;
			}
		}

		return undefined;
	}

	private async getTitleAndDescription(compareBranch: Branch, baseBranch: string): Promise<{ title: string, description: string }> {
		// Use same default as GitHub, if there is only one commit, use the commit, otherwise use the branch name, as long as it is not the default branch.
		// By default, the base branch we use for comparison is the base branch of origin. Compare this to the
		// compare branch if it has a GitHub remote.
		const origin = await this._folderRepositoryManager.getOrigin(compareBranch);

		let useBranchName = this._pullRequestDefaults.base === compareBranch.name;
		Logger.debug(`Compare branch name: ${compareBranch.name}, Base branch name: ${this._pullRequestDefaults.base}`, 'CreatePullRequestViewProvider');
		try {
			const totalCommits = await this.getTotalGitHubCommits(compareBranch, baseBranch);
			Logger.debug(`Total commits: ${totalCommits}`, 'CreatePullRequestViewProvider');
			if (totalCommits === undefined) {
				// There is no upstream branch. Use the last commit as the title and description.
				useBranchName = false;
			} else if (totalCommits > 1) {
				const defaultBranch = await origin.getDefaultBranch();
				useBranchName = defaultBranch !== compareBranch.name;
			}
		} catch (e) {
			// Ignore and fall back to commit message
			Logger.debug(`Error while getting total commits: ${e}`, 'CreatePullRequestViewProvider');
		}

		const name = compareBranch.name;
		const lastCommit = name ? titleAndBodyFrom(await this._folderRepositoryManager.getTipCommitMessage(name)) : undefined;
		let title: string = '';
		let description: string = '';

		// Set title
		if (useBranchName && name) {
			title = `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
		} else if (name && lastCommit) {
			title = lastCommit.title;
		}

		// Set description
		const pullRequestTemplate = await this.getPullRequestTemplate();
		if (pullRequestTemplate && lastCommit?.body) {
			description = `${lastCommit.body}\n\n${pullRequestTemplate}`;
		} else if (pullRequestTemplate) {
			description = pullRequestTemplate;
		} else if (lastCommit?.body && (this._pullRequestDefaults.base !== compareBranch.name)) {
			description = lastCommit.body;
		}

		return { title, description };
	}

	private async getPullRequestTemplate(): Promise<string | undefined> {
		const templateUris = await this._folderRepositoryManager.getPullRequestTemplates();
		if (templateUris[0]) {
			try {
				const templateContent = await vscode.workspace.fs.readFile(templateUris[0]);
				return new TextDecoder('utf-8').decode(templateContent);
			} catch (e) {
				Logger.appendLine(`Reading pull request template failed: ${e}`);
				return undefined;
			}
		}

		return undefined;
	}

	private async getMergeConfiguration(owner: string, name: string): Promise<RepoAccessAndMergeMethods> {
		const repo = this._folderRepositoryManager.createGitHubRepositoryFromOwnerName(owner, name);
		return repo.getRepoAccessAndMergeMethods();
	}

	public async initializeParams(reset: boolean = false): Promise<void> {
		if (!this.defaultCompareBranch) {
			throw new DetachedHeadError(this._folderRepositoryManager.repository);
		}

		const defaultBaseRemote: RemoteInfo = {
			owner: this._pullRequestDefaults.owner,
			repositoryName: this._pullRequestDefaults.repo,
		};

		const defaultOrigin = await this._folderRepositoryManager.getOrigin(this.defaultCompareBranch);
		const defaultCompareRemote: RemoteInfo = {
			owner: defaultOrigin.remote.owner,
			repositoryName: defaultOrigin.remote.repositoryName,
		};

		const defaultBaseBranch = this._pullRequestDefaults.base;

		const [configuredGitHubRemotes, allGitHubRemotes, branchesForRemote, defaultTitleAndDescription, mergeConfiguration] = await Promise.all([
			this._folderRepositoryManager.getGitHubRemotes(),
			this._folderRepositoryManager.getAllGitHubRemotes(),
			defaultOrigin.listBranches(this._pullRequestDefaults.owner, this._pullRequestDefaults.repo),
			this.getTitleAndDescription(this.defaultCompareBranch, defaultBaseBranch),
      this.getMergeConfiguration(defaultBaseRemote.owner, defaultBaseRemote.repositoryName)
		]);

		const configuredRemotes: RemoteInfo[] = configuredGitHubRemotes.map(remote => {
			return {
				owner: remote.owner,
				repositoryName: remote.repositoryName,
			};
		});

		const allRemotes: RemoteInfo[] = allGitHubRemotes.map(remote => {
			return {
				owner: remote.owner,
				repositoryName: remote.repositoryName,
			};
		});

		// Ensure default into branch is in the remotes list
		if (!branchesForRemote.includes(this._pullRequestDefaults.base)) {
			branchesForRemote.push(this._pullRequestDefaults.base);
			branchesForRemote.sort();
		}

		let branchesForCompare = branchesForRemote;
		if (defaultCompareRemote.owner !== defaultBaseRemote.owner) {
			branchesForCompare = await defaultOrigin.listBranches(
				defaultCompareRemote.owner,
				defaultCompareRemote.repositoryName,
			);
		}

		// Ensure default from branch is in the remotes list
		if (this.defaultCompareBranch.name && !branchesForCompare.includes(this.defaultCompareBranch.name)) {
			branchesForCompare.push(this.defaultCompareBranch.name);
			branchesForCompare.sort();
		}

		const params: CreateParams = {
			availableBaseRemotes: configuredRemotes,
			availableCompareRemotes: allRemotes,
			defaultBaseRemote,
			defaultBaseBranch,
			defaultCompareRemote,
			defaultCompareBranch: this.defaultCompareBranch.name ?? '',
			branchesForRemote,
			branchesForCompare,
			defaultTitle: defaultTitleAndDescription.title,
			defaultDescription: defaultTitleAndDescription.description,
			isDraft: false,
			defaultMergeMethod: getDefaultMergeMethod(mergeConfiguration.mergeMethodsAvailability),
			allowAutoMerge: mergeConfiguration.viewerCanAutoMerge,
			mergeMethodsAvailability: mergeConfiguration.mergeMethodsAvailability,
			createError: ''
		};

		this._compareBranch = this.defaultCompareBranch.name ?? '';
		this._baseBranch = defaultBaseBranch;

		this._postMessage({
			command: reset ? 'reset' : 'pr.initialize',
			params,
		});
	}

	private async changeRemote(
		message: IRequestMessage<{ owner: string; repositoryName: string }>,
		isBase: boolean,
	): Promise<void> {
		const { owner, repositoryName } = message.args;

		let githubRepository = this._folderRepositoryManager.findRepo(
			repo => owner === repo.remote.owner && repositoryName === repo.remote.repositoryName,
		);

		if (!githubRepository) {
			githubRepository = this._folderRepositoryManager.createGitHubRepositoryFromOwnerName(owner, repositoryName);
		}
		if (!githubRepository) {
			throw new Error('No matching GitHub repository found.');
		}

		const defaultBranch = await githubRepository.getDefaultBranch();
		const newBranches = await githubRepository.listBranches(owner, repositoryName);

		if (!isBase && this.defaultCompareBranch?.name && !newBranches.includes(this.defaultCompareBranch.name)) {
			newBranches.push(this.defaultCompareBranch.name);
			newBranches.sort();
		}

		let newBranch: string | undefined;
		if (isBase) {
			newBranch = defaultBranch;
			this._baseBranch = defaultBranch;
			this._onDidChangeBaseRemote.fire({ owner, repositoryName });
			this._onDidChangeBaseBranch.fire(defaultBranch);
		} else {
			if (this.defaultCompareBranch?.name) {
				newBranch = this.defaultCompareBranch?.name;
				this._compareBranch = this.defaultCompareBranch?.name;
			}
			this._onDidChangeCompareRemote.fire({ owner, repositoryName });
		}

		// TODO: if base is change need to update auto merge
		return this._replyMessage(message, { branches: newBranches, defaultBranch: newBranch });
	}

	private async create(message: IRequestMessage<CreatePullRequest>): Promise<void> {
		try {
			const compareOwner = message.args.compareOwner;
			const compareRepositoryName = message.args.compareRepo;
			const compareBranchName = message.args.compareBranch;
			const compareGithubRemoteName = `${compareOwner}/${compareRepositoryName}`;
			const compareBranch = await this._folderRepositoryManager.repository.getBranch(compareBranchName);
			let headRepo = compareBranch.upstream ? this._folderRepositoryManager.findRepo((githubRepo) => {
				return (githubRepo.remote.owner === compareOwner) && (githubRepo.remote.repositoryName === compareRepositoryName);
			}) : undefined;
			let existingCompareUpstream = headRepo?.remote;

			if (!existingCompareUpstream
				|| (existingCompareUpstream.owner !== compareOwner)
				|| (existingCompareUpstream.repositoryName !== compareRepositoryName)) {
				// We assume this happens only when the compare branch is based on the current branch.
				const shouldPushUpstream = await vscode.window.showInformationMessage(
					`There is no upstream branch for '${compareBranchName}'.\n\nDo you want to publish it and then create the pull request?`,
					{ modal: true },
					'Publish branch',
				);
				if (shouldPushUpstream === 'Publish branch') {
					let createdPushRemote: Remote | undefined;
					const pushRemote = this._folderRepositoryManager.repository.state.remotes.find(localRemote => {
						if (!localRemote.pushUrl) {
							return false;
						}
						const testRemote = new Remote(localRemote.name, localRemote.pushUrl, new Protocol(localRemote.pushUrl));
						if ((testRemote.owner.toLowerCase() === compareOwner.toLowerCase()) && (testRemote.repositoryName.toLowerCase() === compareRepositoryName.toLowerCase())) {
							createdPushRemote = testRemote;
							return true;
						}
						return false;
					});

					if (pushRemote && createdPushRemote) {
						await this._folderRepositoryManager.repository.push(pushRemote.name, compareBranchName, true);
						existingCompareUpstream = createdPushRemote;
						headRepo = this._folderRepositoryManager.findRepo(byRemoteName(existingCompareUpstream.remoteName));
					} else {
						this._throwError(message, `The current repository does not have a push remote for ${compareGithubRemoteName}`);
					}
				}
			}
			if (!existingCompareUpstream) {
				this._throwError(message, 'No upstream for the compare branch.');
				return;
			}

			if (!headRepo) {
				throw new Error(`Unable to find GitHub repository matching '${existingCompareUpstream.remoteName}'. You can add '${existingCompareUpstream.remoteName}' to the setting "githubPullRequests.remotes" to ensure '${existingCompareUpstream.remoteName}' is found.`);
			}

			const head = `${headRepo.remote.owner}:${compareBranchName}`;
			const createdPR = await this._folderRepositoryManager.createPullRequest({ ...message.args, head });

			// Create was cancelled
			if (!createdPR) {
				this._throwError(message, 'There must be a difference in commits to create a pull request.');
			} else {
				if (message.args.autoMerge) {
					await createdPR.enableAutoMerge(message.args.mergeMethod);
				}
				await this._replyMessage(message, {});
				this._onDone.fire(createdPR);
			}
		} catch (e) {
			this._throwError(message, e.message);
		}
	}

	private async changeBranch(message: IRequestMessage<string | { name: string }>, isBase: boolean): Promise<void> {
		const newBranch = (typeof message.args === 'string') ? message.args : message.args.name;
		let compareBranch: Branch | undefined;
		if (isBase) {
			this._baseBranch = newBranch;
			this._onDidChangeBaseBranch.fire(newBranch);
		} else {
			try {
				compareBranch = await this._folderRepositoryManager.repository.getBranch(newBranch);
				this._onDidChangeCompareBranch.fire(compareBranch.name!);
			} catch (e) {
				vscode.window.showErrorMessage('Branch does not exist locally.');
			}
		}

		compareBranch = compareBranch ?? await this._folderRepositoryManager.repository.getBranch(this._compareBranch);
		const titleAndDescription = await this.getTitleAndDescription(compareBranch, this._baseBranch);
		return this._replyMessage(message, { title: titleAndDescription.title, description: titleAndDescription.description });
	}

	protected async _onDidReceiveMessage(message: IRequestMessage<any>) {
		const result = await super._onDidReceiveMessage(message);
		if (result !== this.MESSAGE_UNHANDLED) {
			return;
		}

		switch (message.command) {
			case 'pr.cancelCreate':
				vscode.commands.executeCommand('setContext', 'github:createPullRequest', false);
				this._onDone.fire(undefined);
				return this._replyMessage(message, undefined);

			case 'pr.create':
				return this.create(message);

			case 'pr.changeBaseRemote':
				return this.changeRemote(message, true);

			case 'pr.changeBaseBranch':
				return this.changeBranch(message, true);

			case 'pr.changeCompareRemote':
				return this.changeRemote(message, false);

			case 'pr.changeCompareBranch':
				return this.changeBranch(message, false);

			default:
				// Log error
				vscode.window.showErrorMessage('Unsupported webview message');
		}
	}

	private _getHtmlForWebview() {
		const nonce = getNonce();

		const uri = vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview-create-pr-view.js');

		return `<!DOCTYPE html>
<html lang="en">
	<head>
		<meta charset="UTF-8">
		<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src vscode-resource: https:; script-src 'nonce-${nonce}'; style-src vscode-resource: 'unsafe-inline' http: https: data:;">
		<meta name="viewport" content="width=device-width, initial-scale=1.0">

		<title>Create Pull Request</title>
	</head>
	<body>
		<div id="app"></div>
		<script nonce="${nonce}" src="${this._webview!.asWebviewUri(uri).toString()}"></script>
	</body>
</html>`;
	}
}
