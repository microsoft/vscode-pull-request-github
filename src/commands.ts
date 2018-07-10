/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import { ReviewManager } from './view/reviewManager';
import { PullRequestOverviewPanel } from './github/pullRequestOverview';
import { fromReviewUri } from './common/uri';
import { FileChangeNode } from './view/treeNodes/fileChangeNode';
import { PRNode } from './view/treeNodes/pullRequestNode';
import { IPullRequestManager, IPullRequestModel, IPullRequest } from './github/interface';

const _onDidClosePR = new vscode.EventEmitter<IPullRequest>();
export const onDidClosePR: vscode.Event<IPullRequest> = _onDidClosePR.event;

function ensurePR(prManager: IPullRequestManager, pr?: PRNode | IPullRequestModel): IPullRequestModel {
	// If the command is called from the command palette, no arguments are passed.
	if (!pr) {
		if (!prManager.activePullRequest) {
			vscode.window.showErrorMessage('Unable to find current pull request.');
			return;
		}

		return prManager.activePullRequest;
	} else {
		return pr instanceof PRNode ? pr.pullRequestModel : pr;
	}
}

export function registerCommands(context: vscode.ExtensionContext, prManager: IPullRequestManager, reviewManager: ReviewManager) {
	// initialize resources
	context.subscriptions.push(vscode.commands.registerCommand('pr.openInGitHub', (e: PRNode | FileChangeNode | IPullRequestModel) => {
		if (!e) {
			if (prManager.activePullRequest) {
				vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(prManager.activePullRequest.html_url));
			}
			return;
		}
		if (e instanceof PRNode) {
			vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(e.pullRequestModel.html_url));
		} else if (e instanceof FileChangeNode) {
			vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(e.blobUrl));
		} else {
			vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(e.html_url));
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.pick', async (pr: PRNode | IPullRequestModel) => {
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
			await reviewManager.switch(pullRequestModel);
		});
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.close', async (pr?: PRNode) => {
		const pullRequest = ensurePR(prManager, pr);
		return vscode.window.showWarningMessage(`Are you sure you want to close this pull request? This will close the pull request without merging.`, 'Yes', 'No').then(async value => {
			if (value === 'Yes') {
				let newPR = await prManager.closePullRequest(pullRequest);
				vscode.commands.executeCommand('pr.refreshList');
				_onDidClosePR.fire(newPR);
			}

			_onDidClosePR.fire(null);
		});
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.openDescription', async (pr: IPullRequestModel) => {
		const pullRequest = ensurePR(prManager, pr);
		// Create and show a new webview
		PullRequestOverviewPanel.createOrShow(context.extensionPath, prManager, pullRequest);
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.viewChanges', async (fileChange: FileChangeNode) => {
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
