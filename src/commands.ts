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
import { Comment } from './common/comment';
import { formatError } from './common/utils';

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
	context.subscriptions.push(vscode.commands.registerCommand('pr.openPullRequestInGitHub', (e: PRNode | IPullRequestModel) => {
		if (!e) {
			if (prManager.activePullRequest) {
				vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(prManager.activePullRequest.html_url));
			}
			return;
		}
		if (e instanceof PRNode) {
			vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(e.pullRequestModel.html_url));
		} else {
			vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(e.html_url));
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.openFileInGitHub', (e: FileChangeNode) => {
		vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(e.blobUrl));
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.openDiffView', (parentFilePath: string, filePath: string, fileName: string, isPartial: boolean, opts: any) => {
		if (isPartial) {
			vscode.window.showInformationMessage('Your local repository is not up to date so only partial content is being displayed');
		}
		vscode.commands.executeCommand('vscode.diff', parentFilePath, filePath, fileName, opts);
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.deleteLocalBranch', async (e: PRNode) => {
		const pullRequestModel = ensurePR(prManager, e);
		try {
			await prManager.deleteLocalPullRequest(pullRequestModel);
			vscode.commands.executeCommand('pr.refreshList');
		} catch (e) {
			vscode.window.showErrorMessage(`Deleting local pull request branch failed: ${e}`);
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.pick', async (pr: PRNode | IPullRequestModel) => {
		let pullRequestModel;

		if (pr instanceof PRNode) {
			pullRequestModel = pr.pullRequestModel;
		} else {
			pullRequestModel = pr;
		}

		return vscode.window.withProgress({
			location: vscode.ProgressLocation.SourceControl,
			title: `Switching to Pull Request #${pullRequestModel.prNumber}`,
		}, async (progress, token) => {
			await reviewManager.switch(pullRequestModel);
		});
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.close', async (pr?: PRNode, message?: string) => {
		const pullRequest = ensurePR(prManager, pr);
		return vscode.window.showWarningMessage(`Are you sure you want to close this pull request on GitHub? This will close the pull request without merging.`, 'Yes', 'No').then(async value => {
			if (value === 'Yes') {
				try {
					let newComment: Comment;
					if (message) {
						newComment = await prManager.createIssueComment(pullRequest, message);
					}

					let newPR = await prManager.closePullRequest(pullRequest);
					vscode.commands.executeCommand('pr.refreshList');
					_onDidClosePR.fire(newPR);
					return newComment;
				} catch (e) {
					vscode.window.showErrorMessage(`Unable to close pull request. ${formatError(e)}`);
					_onDidClosePR.fire(null);
				}
			}

			_onDidClosePR.fire(null);
		});
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.approve',  async (pr: IPullRequestModel, message?: string) => {
		return await prManager.approvePullRequest(pr, message);
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.requestChanges',  async (pr: IPullRequestModel, message?: string) => {
		return await prManager.requestChanges(pr, message);
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
				commit: previousCommit,
				base: true
			})
		});
		return vscode.commands.executeCommand('vscode.diff', previousFileUri, fileChange.filePath, `${fileChange.fileName} from ${commit.substr(0, 8)}`, { preserveFocus: true });
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.signin', async () => {
		await prManager.authenticate();
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.signinAndRefreshList', async () => {
		if (await prManager.authenticate()) {
			vscode.commands.executeCommand('pr.refreshList');
		}
	}));
}
