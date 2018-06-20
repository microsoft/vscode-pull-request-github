/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import { PullRequestModel } from './github/pullRequestModel';
import { ReviewManager } from './review/reviewManager';
import { PullRequestOverviewPanel } from './github/pullRequestOverview';
import { fromReviewUri } from './common/uri';
import { PRFileChangeNode } from './tree/prFileChangeNode';
import { PRNode } from './tree/prNode';
import { IPullRequestManager } from './common/pullRequest';

export function registerCommands(context: vscode.ExtensionContext, prManager: IPullRequestManager) {
	// initialize resources
	context.subscriptions.push(vscode.commands.registerCommand('pr.openInGitHub', (e: PRNode | PRFileChangeNode) => {
		if (!e) {
			if (ReviewManager.instance.currentPullRequest) {
				vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(ReviewManager.instance.currentPullRequest.html_url));
			}
			return;
		}
		if (e instanceof PRNode) {
			vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(e.pullRequestModel.html_url));
		} else {
			vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(e.blobUrl));
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.pick', async (pr: PRNode | PullRequestModel) => {
		let pullRequestModel;

		if (pr instanceof PRNode) {
			pullRequestModel = pr.pullRequestModel;
		} else {
			pullRequestModel = pr;
		}

		vscode.window.withProgress({
			location: vscode.ProgressLocation.SourceControl,
			title: `Switching to Pull Request #${pullRequestModel.prNumber}`,
		}, async (progress, token) => {
			await ReviewManager.instance.switch(pullRequestModel);
		});
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.close', async (pr: PRNode) => {
		vscode.window.showWarningMessage(`Are you sure you want to close PR`, 'Yes', 'No').then(async value => {
			if (value === 'Yes') {
				let newPR = await prManager.closePullRequest(pr.pullRequestModel);
				return newPR;
			}

			return null;
		});
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.openDescription', async (pr: PullRequestModel) => {
		// Create and show a new webview
		PullRequestOverviewPanel.createOrShow(context.extensionPath, prManager, pr);
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.viewChanges', async (fileChange: PRFileChangeNode) => {
		// Show the file change in a diff view.
		let { path, ref, commit } = fromReviewUri(fileChange.filePath);
		let previousCommit = `${commit}^`;
		let previousFileUri = fileChange.filePath.with({
			query: JSON.stringify({
				path: path,
				ref: ref,
				commit: previousCommit
			})
		});
		return vscode.commands.executeCommand('vscode.diff', previousFileUri, fileChange.filePath, `${fileChange.fileName} from ${commit.substr(0, 8)}`);
	}));
}
