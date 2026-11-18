/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { RepoToolBase } from './toolsUtils';
import { ITelemetry } from '../../common/telemetry';
import { CredentialStore } from '../../github/credentials';
import { FolderRepositoryManagerResolver } from '../../github/folderRepositoryManagerResolver';
import { PullRequestOverviewPanel } from '../../github/pullRequestOverview';
import { RepositoriesManager } from '../../github/repositoriesManager';

interface OpenPullRequestWebviewToolParameters {
	pullRequestNumber: number;
	repo?: {
		owner?: string;
		name?: string;
	};
}

export class OpenPullRequestWebviewTool extends RepoToolBase<OpenPullRequestWebviewToolParameters> {
	public static readonly toolId = 'github-pull-request_openPullRequestWebview';

	constructor(
		credentialStore: CredentialStore,
		repositoriesManager: RepositoriesManager,
		private readonly folderRepositoryManagerResolver: FolderRepositoryManagerResolver,
		private readonly telemetry: ITelemetry,
		private readonly extensionUri: vscode.Uri,
	) {
		super(credentialStore, repositoriesManager);
	}

	async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<OpenPullRequestWebviewToolParameters>): Promise<vscode.PreparedToolInvocation> {
		const pullRequestNumber = options.input.pullRequestNumber;
		if (!pullRequestNumber) {
			return {
				invocationMessage: vscode.l10n.t('Opening pull request'),
			};
		}
		const { owner, name } = await this.getRepoName({ owner: options.input.repo?.owner, name: options.input.repo?.name });
		return {
			invocationMessage: vscode.l10n.t('Opening pull request {0}/{1}#{2}', owner, name, pullRequestNumber),
			pastTenseMessage: vscode.l10n.t('Opened pull request {0}/{1}#{2}', owner, name, pullRequestNumber),
		};
	}

	async invoke(options: vscode.LanguageModelToolInvocationOptions<OpenPullRequestWebviewToolParameters>, _token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult> {
		const pullRequestNumber = options.input.pullRequestNumber;
		if (!pullRequestNumber) {
			throw new Error('No pull request number provided.');
		}
		const { owner, name } = await this.getRepoName({ owner: options.input.repo?.owner, name: options.input.repo?.name });
		// Unlike the repositories manager, the resolver also has a manager for repositories that are not open, such as in the Agents window.
		const folderManager = this.folderRepositoryManagerResolver.getManagerForRepository(owner, name);
		// The webview is shown with a preview while the pull request loads, and is closed if it cannot be found.
		const pullRequest = folderManager.resolvePullRequest(owner, name, pullRequestNumber, false, 'overview').then(model => {
			if (!model) {
				throw new Error(`No pull request found for ${owner}/${name}#${pullRequestNumber}. Make sure the pull request exists.`);
			}
			return model;
		});
		await PullRequestOverviewPanel.createOrShow(this.telemetry, this.extensionUri, folderManager, { owner, repo: name, number: pullRequestNumber }, pullRequest);
		const { title, html_url } = await pullRequest;
		return new vscode.LanguageModelToolResult([
			new vscode.LanguageModelTextPart(`Opened pull request ${owner}/${name}#${pullRequestNumber} "${title}" (${html_url}) in the pull request webview.`),
		]);
	}
}
