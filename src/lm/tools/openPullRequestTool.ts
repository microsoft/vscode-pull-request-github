/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { PullRequestModel } from '../../github/pullRequestModel';
import { PullRequestOverviewPanel } from '../../github/pullRequestOverview';
import { PullRequestTool } from './activePullRequestTool';

export class OpenPullRequestTool extends PullRequestTool {
	public static readonly toolId = 'github-pull-request_openPullRequest';

	protected _findActivePullRequest(): PullRequestModel | undefined {
		// First check if there's a PR overview panel open
		const panelPR = PullRequestOverviewPanel.currentPanel?.getCurrentItem();
		if (panelPR) {
			return panelPR;
		}

		// If no overview panel is open, check if there's an active PR (checked out locally)
		// This covers the case where users are viewing PR diffs without the overview panel
		const folderManager = this.folderManagers.folderManagers.find((manager) => manager.activePullRequest);
		return folderManager?.activePullRequest;
	}

	protected _confirmationTitle(): string {
		return vscode.l10n.t('Open Pull Request');
	}

	override async prepareInvocation(): Promise<vscode.PreparedToolInvocation> {
		const pullRequest = this._findActivePullRequest();
		return {
			pastTenseMessage: pullRequest ? vscode.l10n.t('Read pull request "{0}"', pullRequest.title) : vscode.l10n.t('No open pull request'),
			invocationMessage: pullRequest ? vscode.l10n.t('Reading pull request "{0}"', pullRequest.title) : vscode.l10n.t('Reading open pull request'),
			confirmationMessages: { title: this._confirmationTitle(), message: pullRequest ? vscode.l10n.t('Allow reading the details of "{0}"?', pullRequest.title) : vscode.l10n.t('Allow reading the details of the open pull request?') },
		};
	}

	override async invoke(options: vscode.LanguageModelToolInvocationOptions<any>, token: vscode.CancellationToken): Promise<vscode.ExtendedLanguageModelToolResult | undefined> {
		let pullRequest = this._findActivePullRequest();

		if (!pullRequest) {
			return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('There is no open pull request')]);
		}

		// Delegate to the base class for the actual implementation
		return super.invoke(options, token);
	}
}