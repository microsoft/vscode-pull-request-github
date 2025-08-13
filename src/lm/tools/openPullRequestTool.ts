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
		return PullRequestOverviewPanel.currentPanel?.getCurrentItem();
	}

	protected _confirmationTitle(): string {
		return vscode.l10n.t('Open Pull Request');
	}
}