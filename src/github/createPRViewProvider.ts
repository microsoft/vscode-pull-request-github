/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { FolderRepositoryManager, titleAndBodyFrom } from './folderRepositoryManager';
import webviewContent from '../../media/createPR-webviewIndex.js';
import { getNonce, IRequestMessage, WebviewBase } from '../common/webview';
import { PullRequestDescriptionSource, PullRequestDescriptionSourceEnum, PullRequestTitleSource, PullRequestTitleSourceEnum } from '../view/quickpick';
import * as PersistentState from '../common/persistentState';
import { PR_SETTINGS_NAMESPACE, PR_TITLE } from '../common/settingKeys';
import { OctokitCommon } from './common';
import { PullRequestModel } from './pullRequestModel';

interface RemoteInfo {
	owner: string;
	repositoryName: string;
}

export class CreatePullRequestViewProvider extends WebviewBase implements vscode.WebviewViewProvider {
	public static readonly viewType = 'github:createPullRequest';

	private _webviewView: vscode.WebviewView;

	private _onDone = new vscode.EventEmitter<PullRequestModel | undefined> ();
	readonly onDone: vscode.Event<PullRequestModel | undefined> = this._onDone.event;

	constructor(
		private readonly _extensionUri: vscode.Uri,
		private readonly _folderRepositoryManager: FolderRepositoryManager,
		private readonly _isDraft: boolean
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
		this._webviewView.show();
	}

	private async getTitle(): Promise<string> {
		const method = vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE).get<PullRequestTitleSource>(PR_TITLE, PullRequestTitleSourceEnum.Ask);

		switch (method) {

			case PullRequestTitleSourceEnum.Branch:
				return this._folderRepositoryManager.repository.state.HEAD!.name!;

			case PullRequestTitleSourceEnum.Commit:
				return titleAndBodyFrom(await this._folderRepositoryManager.getHeadCommitMessage()).title;

			default:
				return '';
		}
	}

	private async getDescription(): Promise<string> {
		const method = vscode.workspace.getConfiguration('githubPullRequests').get<PullRequestDescriptionSource>('pullRequestDescription', PullRequestDescriptionSourceEnum.Ask);

		switch (method) {

			case PullRequestDescriptionSourceEnum.Template:
				const templateUris = await this._folderRepositoryManager.getPullRequestTemplates();
				if (templateUris[0]) {
					try {
						const templateContent = await vscode.workspace.fs.readFile(templateUris[0]);
						return templateContent.toString();
					} catch (e) {
						// Logger.appendLine(`Reading pull request template failed: ${e}`);
						return '';
					}
				}

			case PullRequestDescriptionSourceEnum.Commit:
				return titleAndBodyFrom(await this._folderRepositoryManager.getHeadCommitMessage()).body;

			default:
				return '';
		}
	}

	public async initializeParams(): Promise<void> {
		const pullRequestDefaults = await this._folderRepositoryManager.getPullRequestDefaults();

		const defaultRemote: RemoteInfo = {
			owner: pullRequestDefaults.owner,
			repositoryName: pullRequestDefaults.repo
		};

		Promise.all([
			this._folderRepositoryManager.getGitHubRemotes(),
			this._folderRepositoryManager.listBranches(pullRequestDefaults.owner, pullRequestDefaults.repo),
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
					defaultBranch: pullRequestDefaults.base,
					branchesForRemote,
					defaultTitle,
					defaultDescription
				}
			});
		});
	}

	private async askForAlwaysUse(stateKey: string, message: string, titleSource: PullRequestTitleSourceEnum): Promise<void> {
		const config = vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE);
		if (config.get(PR_TITLE) === titleSource) {
			return;
		}

		const showPrompt = PersistentState.fetch('prompts', stateKey);
		if (!showPrompt || showPrompt === PersistentState.MISSING) {
			vscode.window.showInformationMessage(
				`Would you like to always use the ${message} as the title of the pull request?`,
				{ modal: true },
				...['Yes', `Don't Ask Again`]).then(async result => {
					if (result === 'Yes') {
						config.update(PR_TITLE, titleSource, true);
					}

					if (result === `Don't Ask Again`) {
						await PersistentState.store('prompts', stateKey, true);
					}
				});
		}
	}

	private async getCommitForTitle(message: IRequestMessage<undefined>): Promise<void> {
		await this.askForAlwaysUse('commit pr title', 'commit message', PullRequestTitleSourceEnum.Commit);
		const commit = titleAndBodyFrom(await this._folderRepositoryManager.getHeadCommitMessage()).title;
		return this._replyMessage(message, commit);
	}

	private async getBranchForTitle(message: IRequestMessage<undefined>): Promise<void> {
		await this.askForAlwaysUse('branch pr title', 'branch name', PullRequestTitleSourceEnum.Branch);
		const branch = this._folderRepositoryManager.repository.state.HEAD!.name!;
		return this._replyMessage(message, branch);
	}

	private async changeRemote(message: IRequestMessage<{ owner: string, repositoryName: string}>): Promise<void> {
		const { owner, repositoryName } = message.args;
		const githubRepository = this._folderRepositoryManager.findRepo(repo => owner === repo.remote.owner && repositoryName === repo.remote.repositoryName);

		if (!githubRepository) {
			throw new Error('No matching GitHub repository found.');
		}

		const defaultBranch = await githubRepository.getDefaultBranch();
		const newBranches = await this._folderRepositoryManager.listBranches(owner, repositoryName);
		return this._replyMessage(message, { branches: newBranches, defaultBranch });
	}

	private async create(message: IRequestMessage<OctokitCommon.PullsCreateParams>): Promise<void> {
		try {
			const head = this._folderRepositoryManager.repository.state.HEAD!.name!;
			const createdPR = await this._folderRepositoryManager.createPullRequest({ ...message.args, head, draft: this._isDraft });

			// Create was cancelled
			if (!createdPR) {
				this._throwError(message, undefined);
			} else {
				await this._replyMessage(message, {});
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
			// TODO some cleanup of resources for cancel and create
			case 'pr.cancelCreate':
				vscode.commands.executeCommand('setContext', 'github:createPullRequest', false);
				this._onDone.fire(undefined);
				return;

			case 'pr.create':
				return this.create(message);

			case 'pr.changeRemote':
				return this.changeRemote(message);

			case 'pr.useCommitForTitle':
				return this.getCommitForTitle(message);

			case 'pr.useBranchForTitle':
				return this.getBranchForTitle(message);

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

			<title>Active Pull Request</title>
		</head>
		<body>
			<div id="app"></div>
			<script nonce="${nonce}">${webviewContent}</script>
		</body>
		</html>`;
	}
}