/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { byRemoteName, DetachedHeadError, FolderRepositoryManager, PullRequestDefaults, titleAndBodyFrom } from './folderRepositoryManager';
import webviewContent from '../../media/createPR-webviewIndex.js';
import { getNonce, IRequestMessage, WebviewBase } from '../common/webview';
import { PR_SETTINGS_NAMESPACE, PR_TITLE } from '../common/settingKeys';
import { OctokitCommon } from './common';
import { PullRequestModel } from './pullRequestModel';
import Logger from '../common/logger';
import { PullRequestGitHelper } from './pullRequestGitHelper';
import { Branch } from '../api/api';

export type PullRequestTitleSource = 'commit' | 'branch' | 'custom' | 'ask';

export enum PullRequestTitleSourceEnum {
	Commit = 'commit',
	Branch = 'branch',
	Custom = 'custom',
	Ask = 'ask'
}

export type PullRequestDescriptionSource = 'template' | 'commit' | 'custom' | 'ask';

export enum PullRequestDescriptionSourceEnum {
	Template = 'template',
	Commit = 'commit',
	Custom = 'custom',
	Ask = 'ask'
}

interface RemoteInfo {
	owner: string;
	repositoryName: string;
}

export class CreatePullRequestViewProvider extends WebviewBase implements vscode.WebviewViewProvider {
	public static readonly viewType = 'github:createPullRequest';

	private _webviewView: vscode.WebviewView | undefined;

	private _onDone = new vscode.EventEmitter<PullRequestModel | undefined>();
	readonly onDone: vscode.Event<PullRequestModel | undefined> = this._onDone.event;

	private _onDidChangeBaseRemote = new vscode.EventEmitter<RemoteInfo>();
	readonly onDidChangeBaseRemote: vscode.Event<RemoteInfo> = this._onDidChangeBaseRemote.event;

	private _onDidChangeBaseBranch = new vscode.EventEmitter<string>();
	readonly onDidChangeBaseBranch: vscode.Event<string> = this._onDidChangeBaseBranch.event;

	private _onDidChangeCompareBranch = new vscode.EventEmitter<string>();
	readonly onDidChangeCompareBranch: vscode.Event<string> = this._onDidChangeCompareBranch.event;

	constructor(
		private readonly _extensionUri: vscode.Uri,
		private readonly _folderRepositoryManager: FolderRepositoryManager,
		private readonly _pullRequestDefaults: PullRequestDefaults,
		private readonly _compareBranch: Branch,
		private readonly _isDraft: boolean,
	) {
		super();
	}

	public resolveWebviewView(
		webviewView: vscode.WebviewView,
		context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken,
	) {

		this._webviewView = webviewView;
		this._webview = webviewView.webview;
		super.initialize();
		webviewView.webview.options = {
			// Allow scripts in the webview
			enableScripts: true,

			localResourceRoots: [
				this._extensionUri
			]
		};

		webviewView.webview.html = this._getHtmlForWebview();

		this.initializeParams();
	}

	public show() {
		if (this._webviewView) {
			this._webviewView.show();
		} else {
			vscode.commands.executeCommand('github:createPullRequest.focus');
		}
	}

	private async getTitle(): Promise<string> {
		const method = vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE).get<PullRequestTitleSource>(PR_TITLE, PullRequestTitleSourceEnum.Ask);

		switch (method) {

			case PullRequestTitleSourceEnum.Branch:
				return this._compareBranch.name!;

			case PullRequestTitleSourceEnum.Commit:
				return titleAndBodyFrom(await this._folderRepositoryManager.getTipCommitMessage(this._compareBranch.name!)).title;

			case PullRequestTitleSourceEnum.Custom:
				return '';

			default:
				// Use same default as GitHub, if there is only one commit, use the commit, otherwise use the branch name.
				// By default, the base branch we use for comparison is the base branch of origin. Compare this to the
				// compare branch if it has a GitHub remote.
				const origin = await this._folderRepositoryManager.getOrigin();

				let hasMultipleCommits = true;
				if (this._compareBranch.upstream) {
					const headRepo = this._folderRepositoryManager.findRepo(byRemoteName(this._compareBranch.upstream.remote));
					if (headRepo) {
						const headBranch = `${headRepo.remote.owner}:${this._compareBranch.name ?? ''}`;
						const commits = await origin.compareCommits(this._pullRequestDefaults.base, headBranch);
						hasMultipleCommits = commits.total_commits > 1;
					}
				}

				if (hasMultipleCommits) {
					return this._compareBranch.name!;
				} else {
					return titleAndBodyFrom(await this._folderRepositoryManager.getTipCommitMessage(this._compareBranch.name!)).title;
				}
		}
	}

	private async getPullRequestTemplate(): Promise<string> {
		const templateUris = await this._folderRepositoryManager.getPullRequestTemplates();
		if (templateUris[0]) {
			try {
				const templateContent = await vscode.workspace.fs.readFile(templateUris[0]);
				return templateContent.toString();
			} catch (e) {
				Logger.appendLine(`Reading pull request template failed: ${e}`);
				return '';
			}
		}

		return '';
	}

	private async getDescription(): Promise<string> {
		const method = vscode.workspace.getConfiguration('githubPullRequests').get<PullRequestDescriptionSource>('pullRequestDescription', PullRequestDescriptionSourceEnum.Ask);

		switch (method) {

			case PullRequestDescriptionSourceEnum.Template:
				return this.getPullRequestTemplate();

			case PullRequestDescriptionSourceEnum.Commit:
				return titleAndBodyFrom(await this._folderRepositoryManager.getTipCommitMessage(this._compareBranch.name!)).title;

			case PullRequestDescriptionSourceEnum.Custom:
				return '';

			default:
				// Try to match github's default, first look for template, then use commit body if available.
				const pullRequestTemplate = this.getPullRequestTemplate();
				return pullRequestTemplate ?? titleAndBodyFrom(await this._folderRepositoryManager.getTipCommitMessage(this._compareBranch.name!)).body ?? '';
		}
	}

	public async initializeParams(): Promise<void> {
		if (!this._compareBranch) {
			throw new DetachedHeadError(this._folderRepositoryManager.repository);
		}

		const defaultRemote: RemoteInfo = {
			owner: this._pullRequestDefaults.owner,
			repositoryName: this._pullRequestDefaults.repo
		};

		Promise.all([
			this._folderRepositoryManager.getGitHubRemotes(),
			this._folderRepositoryManager.listBranches(this._pullRequestDefaults.owner, this._pullRequestDefaults.repo),
			this.getTitle(),
			this.getDescription()
		]).then(result => {
			const [githubRemotes, branchesForRemote, defaultTitle, defaultDescription] = result;

			const remotes: RemoteInfo[] = githubRemotes.map(remote => {
				return {
					owner: remote.owner,
					repositoryName: remote.repositoryName
				};
			});

			this._postMessage({
				command: 'pr.initialize',
				params: {
					availableRemotes: remotes,
					defaultRemote,
					defaultBranch: this._pullRequestDefaults.base,
					branchesForRemote,
					defaultTitle,
					defaultDescription,
					compareBranch: this._compareBranch.name!
				}
			});
		});
	}

	private async changeRemote(message: IRequestMessage<{ owner: string, repositoryName: string }>): Promise<void> {
		const { owner, repositoryName } = message.args;
		const githubRepository = this._folderRepositoryManager.findRepo(repo => owner === repo.remote.owner && repositoryName === repo.remote.repositoryName);

		if (!githubRepository) {
			throw new Error('No matching GitHub repository found.');
		}

		const defaultBranch = await githubRepository.getDefaultBranch();
		const newBranches = await this._folderRepositoryManager.listBranches(owner, repositoryName);
		this._onDidChangeBaseRemote.fire({ owner, repositoryName });
		return this._replyMessage(message, { branches: newBranches, defaultBranch });
	}

	private async create(message: IRequestMessage<OctokitCommon.PullsCreateParams>): Promise<void> {
		try {
			// TODO@eamodio Why do we assume this is a detached head? if the upstream is missing isn't it just unpublished?
			if (!this._compareBranch.upstream) {
				throw new DetachedHeadError(this._folderRepositoryManager.repository);
			}

			const branchName = this._compareBranch.name!;
			const headRepo = this._folderRepositoryManager.findRepo(byRemoteName(this._compareBranch.upstream.remote));
			if (!headRepo) {
				throw new Error(`Unable to find GitHub repository matching '${this._compareBranch.upstream.remote}'.`);
			}

			const head = `${headRepo.remote.owner}:${branchName}`;
			const createdPR = await this._folderRepositoryManager.createPullRequest({ ...message.args, head, draft: this._isDraft });

			// Create was cancelled
			if (!createdPR) {
				this._throwError(message, undefined);
			} else {
				await this._replyMessage(message, {});
				await PullRequestGitHelper.associateBranchWithPullRequest(this._folderRepositoryManager.repository, createdPR, branchName);
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
				return;

			case 'pr.create':
				return this.create(message);

			case 'pr.changeRemote':
				return this.changeRemote(message);

			case 'pr.changeBaseBranch':
				this._onDidChangeBaseBranch.fire(message.args);
				return;

			case 'pr.changeCompareBranch':
				this._onDidChangeCompareBranch.fire(message.args);
				return;

			default:
				// Log error
				vscode.window.showErrorMessage('Unsupported webview message');
		}
	}

	private _getHtmlForWebview() {
		const nonce = getNonce();

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
			<script nonce="${nonce}">${webviewContent}</script>
		</body>
		</html>`;
	}
}