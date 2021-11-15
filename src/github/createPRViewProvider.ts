/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { Branch } from '../api/api';
import { RefType } from '../api/api1';
import Logger from '../common/logger';
import { getNonce, IRequestMessage, WebviewViewBase } from '../common/webview';
import { OctokitCommon } from './common';
import {
	byRemoteName,
	DetachedHeadError,
	FolderRepositoryManager,
	PullRequestDefaults,
	titleAndBodyFrom,
} from './folderRepositoryManager';
import { PullRequestGitHelper } from './pullRequestGitHelper';
import { PullRequestModel } from './pullRequestModel';

interface RemoteInfo {
	owner: string;
	repositoryName: string;
}

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

	private _firstLoad: boolean = true;

	constructor(
		extensionUri: vscode.Uri,
		private readonly _folderRepositoryManager: FolderRepositoryManager,
		private readonly _pullRequestDefaults: PullRequestDefaults,
		compareBranch: Branch,
	) {
		super(extensionUri);

		this._compareBranch = compareBranch;
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

	private _compareBranch: Branch;
	get compareBranch() {
		return this._compareBranch;
	}

	set compareBranch(compareBranch: Branch | undefined) {
		if (
			compareBranch &&
			(compareBranch?.name !== this._compareBranch.name ||
				compareBranch?.upstream?.remote !== this._compareBranch.upstream?.remote)
		) {
			this._compareBranch = compareBranch;
			void this.initializeParams();
			this._onDidChangeCompareBranch.fire(this._compareBranch.name!);
		}
	}

	private _compareRemote: RemoteInfo | undefined;
	get compareRemote(): RemoteInfo | undefined {
		return this._compareRemote;
	}

	set compareRemote(ownerAndRepo: RemoteInfo | undefined) {
		if (ownerAndRepo &&
			((ownerAndRepo.owner !== this._compareRemote?.owner) || (ownerAndRepo.repositoryName !== this._compareRemote?.repositoryName))) {
			this._compareRemote = ownerAndRepo;
			void this.initializeParams();
			this._onDidChangeCompareRemote.fire(this._compareRemote);
		}
	}

	public show(compareBranch?: Branch): void {
		if (compareBranch) {
			this.compareBranch = compareBranch;
		}

		super.show();
	}

	private async getTotalCommits(): Promise<number> {
		const origin = await this._folderRepositoryManager.getOrigin(this.compareBranch);

		if (this.compareBranch?.upstream) {
			const headRepo = this._folderRepositoryManager.findRepo(byRemoteName(this.compareBranch.upstream.remote));

			if (headRepo) {
				const headBranch = `${headRepo.remote.owner}:${this.compareBranch.name ?? ''}`;
				const baseBranch = `${this._pullRequestDefaults.owner}:${this._pullRequestDefaults.base}`;
				const { total_commits } = await origin.compareCommits(baseBranch, headBranch);

				return total_commits;
			}
		} else if (this.compareBranch?.commit) {
			// We can use the git API instead of the GitHub API
			const baseBranch = await this._folderRepositoryManager.repository.getBranch(this._pullRequestDefaults.base);
			if (baseBranch.commit) {
				const changes = await this._folderRepositoryManager.repository.diffBetween(baseBranch.commit, this.compareBranch.commit);
				return changes.length;
			}
		}

		return 0;
	}

	private async getTitle(): Promise<string> {
		// Use same default as GitHub, if there is only one commit, use the commit, otherwise use the branch name, as long as it is not the default branch.
		// By default, the base branch we use for comparison is the base branch of origin. Compare this to the
		// compare branch if it has a GitHub remote.
		const origin = await this._folderRepositoryManager.getOrigin(this.compareBranch);

		let useBranchName = false;

		try {
			const totalCommits = await this.getTotalCommits();
			if (totalCommits > 1) {
				const defaultBranch = await origin.getDefaultBranch();
				useBranchName = defaultBranch !== this.compareBranch?.name;
			}
		} catch (e) {
			// Ignore and fall back to commit message
		}

		if (useBranchName) {
			const name = this.compareBranch?.name;
			return name
				? `${name.charAt(0).toUpperCase()}${name.slice(1)}`
				: '';
		} else {
			return this.compareBranch?.name
				? titleAndBodyFrom(await this._folderRepositoryManager.getTipCommitMessage(this.compareBranch.name))
					.title
				: '';
		}
	}

	private async getPullRequestTemplate(): Promise<string | undefined> {
		const templateUris = await this._folderRepositoryManager.getPullRequestTemplates();
		if (templateUris[0]) {
			try {
				const templateContent = await vscode.workspace.fs.readFile(templateUris[0]);
				return templateContent.toString();
			} catch (e) {
				Logger.appendLine(`Reading pull request template failed: ${e}`);
				return undefined;
			}
		}

		return undefined;
	}

	private async getDescription(): Promise<string> {
		// Try to match github's default, first look for template, then use commit body if available.
		const pullRequestTemplate = await this.getPullRequestTemplate();
		if (pullRequestTemplate) {
			try {
				const totalCommits = await this.getTotalCommits();

				// If there's just a single commit, we include it as well as the PR template
				if (totalCommits === 1 && this.compareBranch?.name) {
					const message = titleAndBodyFrom(await this._folderRepositoryManager.getTipCommitMessage(this.compareBranch.name)).body;

					return `${message}\n\n${pullRequestTemplate}`;
				}
			} catch (e) {
				// Ignore and fall back to the template
			}

			return pullRequestTemplate;
		}

		return this.compareBranch?.name
			? titleAndBodyFrom(await this._folderRepositoryManager.getTipCommitMessage(this.compareBranch.name)).body
			: '';
	}

	public async initializeParams(reset: boolean = false): Promise<void> {
		if (!this.compareBranch) {
			throw new DetachedHeadError(this._folderRepositoryManager.repository);
		}

		const defaultBaseRemote: RemoteInfo = {
			owner: this._pullRequestDefaults.owner,
			repositoryName: this._pullRequestDefaults.repo,
		};

		const origin = await this._folderRepositoryManager.getOrigin(this.compareBranch);
		const defaultCompareRemote: RemoteInfo = {
			owner: origin.remote.owner,
			repositoryName: origin.remote.repositoryName,
		};

		const [githubRemotes, branchesForRemote, defaultTitle, defaultDescription] = await Promise.all([
			this._folderRepositoryManager.getGitHubRemotes(),
			this._folderRepositoryManager.listBranches(this._pullRequestDefaults.owner, this._pullRequestDefaults.repo),
			this.getTitle(),
			this.getDescription(),
		]);

		const remotes: RemoteInfo[] = githubRemotes.map(remote => {
			return {
				owner: remote.owner,
				repositoryName: remote.repositoryName,
			};
		});

		let branchesForCompare = branchesForRemote;
		if (defaultCompareRemote.owner !== defaultBaseRemote.owner) {
			branchesForCompare = await this._folderRepositoryManager.listBranches(
				defaultCompareRemote.owner,
				defaultCompareRemote.repositoryName,
			);
		}

		if (this.compareBranch.name && !branchesForCompare.includes(this.compareBranch.name)) {
			branchesForCompare.push(this.compareBranch.name);
			branchesForCompare.sort();
		}

		this._postMessage({
			command: reset ? 'reset' : 'pr.initialize',
			params: {
				availableRemotes: remotes,
				defaultBaseRemote,
				defaultBaseBranch: this._pullRequestDefaults.base,
				defaultCompareRemote,
				defaultCompareBranch: this.compareBranch.name ?? '',
				branchesForRemote,
				branchesForCompare,
				defaultTitle,
				defaultDescription,
				compareBranch: this.compareBranch.name ?? '',
				isDraft: false,
			},
		});
	}

	private async changeRemote(
		message: IRequestMessage<{ owner: string; repositoryName: string }>,
		isBase: boolean,
	): Promise<void> {
		const { owner, repositoryName } = message.args;
		const githubRepository = this._folderRepositoryManager.findRepo(
			repo => owner === repo.remote.owner && repositoryName === repo.remote.repositoryName,
		);

		if (!githubRepository) {
			throw new Error('No matching GitHub repository found.');
		}

		const defaultBranch = await githubRepository.getDefaultBranch();
		const newBranches = await this._folderRepositoryManager.listBranches(owner, repositoryName);

		if (!isBase && this.compareBranch?.name && !newBranches.includes(this.compareBranch.name)) {
			newBranches.push(this.compareBranch.name);
			newBranches.sort();
		}

		if (isBase) {
			this._onDidChangeBaseRemote.fire({ owner, repositoryName });
			this._onDidChangeBaseBranch.fire(defaultBranch);
		} else {
			const oldCompareRemote = this.compareRemote;
			this.compareRemote = { owner, repositoryName };
			if (oldCompareRemote &&
				((this.compareRemote.repositoryName !== oldCompareRemote.repositoryName) || (this.compareRemote.owner !== oldCompareRemote.owner))) {
				this.compareBranch = await this._folderRepositoryManager.repository.getBranch(defaultBranch);
			}

		}

		return this._replyMessage(message, { branches: newBranches, defaultBranch: isBase ? defaultBranch : this.compareBranch });
	}

	private async create(message: IRequestMessage<OctokitCommon.PullsCreateParams>): Promise<void> {
		try {
			let branchName;
			let remote;
			if (!this.compareBranch?.name) {
				this._throwError(message, 'Please create a branch.');
				return;
			}

			if (this.compareBranch.type === RefType.RemoteHead) {
				const index = this.compareBranch.name.indexOf('/');
				branchName = this.compareBranch.name.substring(index + 1);
				remote = this.compareBranch.name.substring(0, index);
			} else {
				branchName = this.compareBranch.name;
				remote = this.compareBranch.upstream?.remote;
			}

			if (!remote) {
				// We assume this happens only when the compare branch is based on the current branch.
				const shouldPushUpstream = await vscode.window.showInformationMessage(
					`There is no upstream branch for '${branchName}'.\n\nDo you want to publish it and then create the pull request?`,
					{ modal: true },
					'Publish branch',
				);
				if (shouldPushUpstream === 'Publish branch') {
					let pushRemote: string | undefined;
					if (this._folderRepositoryManager.repository.state.remotes.length === 1) {
						pushRemote = this._folderRepositoryManager.repository.state.remotes[0].name;
					} else if (this._folderRepositoryManager.repository.state.remotes.length > 1) {
						pushRemote = await vscode.window.showQuickPick(
							this._folderRepositoryManager.repository.state.remotes.map(value => value.name),
							{ placeHolder: 'Remote to push to' },
						);
					}
					if (pushRemote) {
						await this._folderRepositoryManager.repository.push(pushRemote, branchName, true);
					} else {
						this._throwError(message, 'The current repository has no remotes to push to. Please set up a remote and try again.');
					}
					if (this._folderRepositoryManager.repository.state.HEAD) {
						remote = pushRemote;
					}
				} else {
					this._throwError(message, 'No upstream for the compare branch.');
					return;
				}
			}

			const headRepo = this._folderRepositoryManager.findRepo(byRemoteName(remote!));
			if (!headRepo) {
				throw new Error(`Unable to find GitHub repository matching '${remote}'. You can add '${remote}' to the setting "githubPullRequests.remotes" to ensure '${remote}' is found.`);
			}

			const head = `${headRepo.remote.owner}:${branchName}`;
			const createdPR = await this._folderRepositoryManager.createPullRequest({ ...message.args, head });

			// Create was cancelled
			if (!createdPR) {
				this._throwError(message, 'There must be a difference in commits to create a pull request.');
			} else {
				await this._replyMessage(message, {});
				await PullRequestGitHelper.associateBranchWithPullRequest(
					this._folderRepositoryManager.repository,
					createdPR,
					branchName,
				);
				this._onDone.fire(createdPR);
			}
		} catch (e) {
			this._throwError(message, e.message);
		}
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
				this._onDidChangeBaseBranch.fire(message.args);
				return this._replyMessage(message, undefined);

			case 'pr.changeCompareRemote':
				return this.changeRemote(message, false);

			case 'pr.changeCompareBranch':
				this.compareBranch = await this._folderRepositoryManager.repository.getBranch(message.args.name ?? message.args);
				return this._replyMessage(message, undefined);

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
