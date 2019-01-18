/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import * as pathLib from 'path';
import { ReviewManager } from './view/reviewManager';
import { PullRequestOverviewPanel } from './github/pullRequestOverview';
import { fromReviewUri, ReviewUriParams } from './common/uri';
import { GitFileChangeNode, InMemFileChangeNode } from './view/treeNodes/fileChangeNode';
import { PRNode } from './view/treeNodes/pullRequestNode';
import { ITelemetry, PullRequest } from './github/interface';
import { formatError } from './common/utils';
import { GitChangeType } from './common/file';
import { getDiffLineByPosition, getZeroBased } from './common/diffPositionMapping';
import { DiffChangeType } from './common/diffHunk';
import { DescriptionNode } from './view/treeNodes/descriptionNode';
import { listHosts, deleteToken } from './authentication/keychain';
import { writeFile, unlink } from 'fs';
import Logger from './common/logger';
import { GitErrorCodes } from './typings/git';
import { Comment } from './common/comment';
import { PullRequestManager } from './github/pullRequestManager';
import { PullRequestModel } from './github/pullRequestModel';

const _onDidUpdatePR = new vscode.EventEmitter<PullRequest | null>();
export const onDidUpdatePR: vscode.Event<PullRequest | null> = _onDidUpdatePR.event;

function ensurePR(prManager: PullRequestManager, pr?: PRNode | PullRequestModel): PullRequestModel {
	// If the command is called from the command palette, no arguments are passed.
	if (!pr) {
		if (!prManager.activePullRequest) {
			vscode.window.showErrorMessage('Unable to find current pull request.');
			throw new Error('Unable to find current pull request.');
		}

		return prManager.activePullRequest;
	} else {
		return pr instanceof PRNode ? pr.pullRequestModel : pr;
	}
}

export function registerCommands(context: vscode.ExtensionContext, prManager: PullRequestManager,
	reviewManager: ReviewManager, telemetry: ITelemetry) {
	context.subscriptions.push(vscode.commands.registerCommand('auth.signout', async () => {
		const selection = await vscode.window.showQuickPick(await listHosts(), { canPickMany: true });
		if (!selection) { return; }
		await Promise.all(selection.map(host => deleteToken(host)));
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.openPullRequestInGitHub', (e: PRNode | PullRequestModel) => {
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

	context.subscriptions.push(vscode.commands.registerCommand('review.suggestDiff', async (e) => {
		try {
			if (prManager.activePullRequest === null) {
				return;
			}

			const { indexChanges, workingTreeChanges } = prManager.repository.state;

			if (!indexChanges.length) {
				if (workingTreeChanges.length) {
					const stageAll = await vscode.window.showWarningMessage('There are no staged changes to suggest.\n\nWould you like to automatically stage all your of changes and suggest them?', { modal: true }, 'Yes');
					if (stageAll === 'Yes') {
						await vscode.commands.executeCommand('git.stageAll');
					} else {
						return;
					}
				} else {
					vscode.window.showInformationMessage('There are no changes to suggest.');
					return;
				}
			}

			const diff = await prManager.repository.diff(true);

			let suggestEditMessage = '';
			if (e && e.inputBox && e.inputBox.value) {
				suggestEditMessage = `${e.inputBox.value}\n`;
				e.inputBox.value = '';
			}

			const suggestEditText = `${suggestEditMessage}\`\`\`diff\n${diff}\n\`\`\``;
			await prManager.createIssueComment(prManager.activePullRequest, suggestEditText);

			// Reset HEAD and then apply reverse diff
			await vscode.commands.executeCommand('git.unstageAll');

			if (vscode.workspace.rootPath === undefined) {
				throw new Error('Current workspace root path is undefined.');
			}

			const tempFilePath = pathLib.resolve(vscode.workspace.rootPath, '.git', `${prManager.activePullRequest.prNumber}.diff`);
			writeFile(tempFilePath, diff, {}, async (writeError) => {
				if (writeError) {
					throw writeError;
				}

				try {
					await prManager.repository.apply(tempFilePath, true);

					unlink(tempFilePath, (err) => {
						if (err) {
							throw err;
						}
					});
				} catch (err) {
					Logger.appendLine(`Applying patch failed: ${err}`);
					vscode.window.showErrorMessage(`Applying patch failed: ${formatError(err)}`);
				}
			});
		} catch (err) {
			Logger.appendLine(`Applying patch failed: ${err}`);
			vscode.window.showErrorMessage(`Applying patch failed: ${formatError(err)}`);
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.openFileInGitHub', (e: GitFileChangeNode) => {
		if (e.blobUrl) {
			vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(e.blobUrl));
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.openDiffView', (fileChangeNode: GitFileChangeNode | InMemFileChangeNode) => {
		const parentFilePath = fileChangeNode.parentFilePath;
		const filePath = fileChangeNode.filePath;
		const fileName = fileChangeNode.fileName;
		const isPartial = fileChangeNode.isPartial;
		const opts = fileChangeNode.opts;

		if (isPartial) {
			vscode.window.showInformationMessage('Your local repository is not up to date so only partial content is being displayed');
		}
		vscode.commands.executeCommand('vscode.diff', parentFilePath, filePath, fileName, opts);
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.deleteLocalBranch', async (e: PRNode) => {
		const pullRequestModel = ensurePR(prManager, e);
		const DELETE_BRANCH_FORCE = 'delete branch (even if not merged)';
		let error = null;

		try {
			await prManager.deleteLocalPullRequest(pullRequestModel);
		} catch (e) {
			if (e.gitErrorCode === GitErrorCodes.BranchNotFullyMerged) {
				let action = await vscode.window.showErrorMessage(`The branch '${pullRequestModel.localBranchName}' is not fully merged, are you sure you want to delete it? `, DELETE_BRANCH_FORCE);

				if (action !== DELETE_BRANCH_FORCE) {
					return;
				}

				try {
					await prManager.deleteLocalPullRequest(pullRequestModel, true);
				} catch (e) {
					error = e;
				}
			} else {
				error = e;
			}
		}

		if (error) {
			await vscode.window.showErrorMessage(`Deleting local pull request branch failed: ${error}`);
		} else {
			// fire and forget
			vscode.commands.executeCommand('pr.refreshList');
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.create', async () => {
		reviewManager.createPullRequest();
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.pick', async (pr: PRNode | DescriptionNode | PullRequestModel) => {
		let pullRequestModel: PullRequestModel;

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
					let newComment: Comment | null = null;
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

	context.subscriptions.push(vscode.commands.registerCommand('pr.approve', async (pr: PullRequestModel, message?: string) => {
		return await prManager.approvePullRequest(pr, message);
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.requestChanges', async (pr: PullRequestModel, message?: string) => {
		return await prManager.requestChanges(pr, message);
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.openDescription', async (descriptionNode: DescriptionNode) => {
		if (!descriptionNode) {
			// the command is triggerred from command palette or status bar, which means we are already in checkout mode.
			let rootNodes = await reviewManager.prFileChangesProvider.getChildren();
			descriptionNode = rootNodes[0] as DescriptionNode;
		}
		const pullRequest = ensurePR(prManager, descriptionNode.pullRequestModel);
		// Create and show a new webview
		PullRequestOverviewPanel.createOrShow(context.extensionPath, prManager, pullRequest, descriptionNode);
		telemetry.on('pr.openDescription');
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.openDescriptionToTheSide', async (descriptionNode: DescriptionNode) => {
		let pr = descriptionNode.pullRequestModel;
		const pullRequest = ensurePR(prManager, pr);
		// Create and show a new webview
		PullRequestOverviewPanel.createOrShow(context.extensionPath, prManager, pullRequest, descriptionNode, true);
		telemetry.on('pr.openDescriptionToTheSide');
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.viewChanges', async (fileChange: GitFileChangeNode) => {
		if (fileChange.status === GitChangeType.DELETE || fileChange.status === GitChangeType.ADD) {
			// create an empty `review` uri without any path/commit info.
			const emptyFileUri = fileChange.parentFilePath.with({
				query: JSON.stringify({
					path: null,
					commit: null,
				})
			});

			return fileChange.status === GitChangeType.DELETE
				? vscode.commands.executeCommand('vscode.diff', fileChange.parentFilePath, emptyFileUri, `${fileChange.fileName}`, { preserveFocus: true })
				: vscode.commands.executeCommand('vscode.diff',  emptyFileUri, fileChange.parentFilePath, `${fileChange.fileName}`, { preserveFocus: true });
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
			const sortedOutdatedComments = fileChange.comments.filter(comment => comment.position === undefined).sort((a, b) => {
				return a.originalPosition! - b.originalPosition!;
			});

			if (sortedOutdatedComments.length) {
				const diffLine = getDiffLineByPosition(fileChange.diffHunks, sortedOutdatedComments[0].originalPosition!);

				if (diffLine) {
					let lineNumber = Math.max(getZeroBased(diffLine.type === DiffChangeType.Delete ? diffLine.oldLineNumber : diffLine.newLineNumber), 0);
					options.selection = new vscode.Range(lineNumber, 0, lineNumber, 0);
				}
			}
		}

		return vscode.commands.executeCommand('vscode.diff', previousFileUri, fileChange.filePath, `${fileChange.fileName} from ${(commit || '').substr(0, 8)}`, options);
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
