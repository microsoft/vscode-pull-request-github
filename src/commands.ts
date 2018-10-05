/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import { ReviewManager } from './view/reviewManager';
import { PullRequestOverviewPanel } from './github/pullRequestOverview';
import { fromReviewUri, ReviewUriParams } from './common/uri';
import { GitFileChangeNode } from './view/treeNodes/fileChangeNode';
import { PRNode } from './view/treeNodes/pullRequestNode';
import { IPullRequestManager, IPullRequestModel, IPullRequest, ITelemetry } from './github/interface';
import { Comment } from './common/comment';
import { formatError } from './common/utils';
import { GitChangeType } from './common/file';
import { getDiffLineByPosition, getZeroBased } from './common/diffPositionMapping';
import { DiffChangeType } from './common/diffHunk';
import { DescriptionNode } from './view/treeNodes/descriptionNode';
import Logger from './common/logger';

const _onDidUpdatePR = new vscode.EventEmitter<IPullRequest>();
export const onDidUpdatePR: vscode.Event<IPullRequest> = _onDidUpdatePR.event;

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

export function registerCommands(context: vscode.ExtensionContext, prManager: IPullRequestManager,
	reviewManager: ReviewManager, telemetry: ITelemetry) {
	// initialize resources
	context.subscriptions.push(vscode.commands.registerCommand('pr.openPullRequestInGitHub', (e: PRNode | IPullRequestModel) => {
		if (!e) {
			if (prManager.activePullRequest) {
				vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(prManager.activePullRequest.html_url));
			}
		} else if (e instanceof PRNode) {
			vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(e.pullRequestModel.html_url));
		} else {
			vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(e.html_url));
		}
		telemetry.on('pr.openInGitHub');
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.openFileInGitHub', (e: GitFileChangeNode) => {
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

	context.subscriptions.push(vscode.commands.registerCommand('pr.create', async () => {
		const repo = prManager.repository;
		const {message} = await repo.getCommit(repo.state.HEAD.commit);
		const idxLineBreak = message.indexOf('\n');
		const headCommit = {
			title: idxLineBreak === -1
				? message
				: message.substr(0, idxLineBreak),

			description: idxLineBreak === -1
				? ''
				: message.slice(idxLineBreak + 1),
		};

		const title = await vscode.window.showInputBox({
			prompt: 'Title',
			value: headCommit.title,
		});
		if (!title) { return; }

		const description = await vscode.window.showInputBox({
			prompt: 'Description',
			value: headCommit.description,
		});
		if (description === undefined) { return; }

		const targetBranch = await vscode.window.showInputBox({
			prompt: 'Target branch',
			value: 'master',
		});
		if (!targetBranch) { return; }

		prManager.createPullRequest(title, description, targetBranch);
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.pick', async (pr: PRNode | DescriptionNode | IPullRequestModel) => {
		let pullRequestModel: IPullRequestModel;

		if (pr instanceof PRNode || pr instanceof DescriptionNode) {
			pullRequestModel = pr.pullRequestModel;
			telemetry.on('pr.checkout.context');
		} else {
			pullRequestModel = pr;
			telemetry.on('pr.checkout.description');
		}

		return vscode.window.withProgress({
			location: vscode.ProgressLocation.SourceControl,
			title: `Switching to Pull Request #${pullRequestModel.prNumber}`,
		}, async (progress, token) => {
			await reviewManager.switch(pullRequestModel);
		});
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.merge', async (pr?: PRNode) => {
		const pullRequest = ensurePR(prManager, pr);
		return vscode.window.showWarningMessage(`Are you sure you want to merge this pull request on GitHub?`, { modal: true }, 'Yes').then(async value => {
			let newPR;
			if (value === 'Yes') {
				try {
					newPR = await prManager.mergePullRequest(pullRequest);
					vscode.commands.executeCommand('pr.refreshList');
					return newPR;
				} catch (e) {
					vscode.window.showErrorMessage(`Unable to merge pull request. ${formatError(e)}`);
					return newPR;
				}
			}

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
					_onDidUpdatePR.fire(newPR);
					return newComment;
				} catch (e) {
					vscode.window.showErrorMessage(`Unable to close pull request. ${formatError(e)}`);
					_onDidUpdatePR.fire(null);
				}
			}

			_onDidUpdatePR.fire(null);
		});
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.approve', async (pr: IPullRequestModel, message?: string) => {
		return await prManager.approvePullRequest(pr, message);
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.requestChanges', async (pr: IPullRequestModel, message?: string) => {
		return await prManager.requestChanges(pr, message);
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.openDescription', async (pr: IPullRequestModel) => {
		const pullRequest = ensurePR(prManager, pr);
		// Create and show a new webview
		PullRequestOverviewPanel.createOrShow(context.extensionPath, prManager, pullRequest);
		telemetry.on('pr.openDescription');
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.viewChanges', async (fileChange: GitFileChangeNode) => {
		if (fileChange.status === GitChangeType.DELETE) {
			// create an empty `review` uri without any path/commit info.
			const emptyFileUri = fileChange.parentFilePath.with({
				query: JSON.stringify({
					path: null,
					commit: null,
				})
			});
			return vscode.commands.executeCommand('vscode.diff', fileChange.parentFilePath, emptyFileUri, `${fileChange.fileName}`, { preserveFocus: true });
		}

		// Show the file change in a diff view.
		let { path, ref, commit } = fromReviewUri(fileChange.filePath);
		let previousCommit = `${commit}^`;
		const query: ReviewUriParams = {
			path: path,
			ref: ref,
			commit: previousCommit,
			base: true,
			isOutdated: true
		};
		const previousFileUri = fileChange.filePath.with({ query: JSON.stringify(query) });

		const options: vscode.TextDocumentShowOptions = {
			preserveFocus: true
		};

		if (fileChange.comments && fileChange.comments.length) {
			const sortedOutdatedComments = fileChange.comments.filter(comment => comment.position === null).sort((a, b) => {
				return a.original_position - b.original_position;
			});

			if (sortedOutdatedComments.length) {
				const diffLine = getDiffLineByPosition(fileChange.diffHunks, sortedOutdatedComments[0].original_position);

				if (diffLine) {
					let lineNumber = Math.max(getZeroBased(diffLine.type === DiffChangeType.Delete ? diffLine.oldLineNumber : diffLine.newLineNumber), 0);
					options.selection = new vscode.Range(lineNumber, 0, lineNumber, 0);
				}
			}
		}

		return vscode.commands.executeCommand('vscode.diff', previousFileUri, fileChange.filePath, `${fileChange.fileName} from ${commit.substr(0, 8)}`, options);
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
