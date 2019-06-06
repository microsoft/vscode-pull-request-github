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
import { CommitNode } from './view/treeNodes/commitNode';
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
import { GitErrorCodes } from './api/api';
import { IComment } from './common/comment';
import { GHPRComment, TemporaryComment } from './github/prComment';
import { PullRequestManager } from './github/pullRequestManager';
import { PullRequestModel } from './github/pullRequestModel';
import { resolveCommentHandler, CommentReply } from './commentHandlerResolver';

const _onDidUpdatePR = new vscode.EventEmitter<PullRequest | undefined>();
export const onDidUpdatePR: vscode.Event<PullRequest | undefined> = _onDidUpdatePR.event;

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

	context.subscriptions.push(vscode.commands.registerCommand('pr.openPullRequestInGitHub', (e: PRNode | DescriptionNode | PullRequestModel) => {
		if (!e) {
			if (prManager.activePullRequest) {
				vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(prManager.activePullRequest.html_url));
			}
		} else if (e instanceof PRNode || e instanceof DescriptionNode) {
			vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(e.pullRequestModel.html_url));
		} else {
			vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(e.html_url));
		}
		telemetry.on('pr.openInGitHub');
	}));

	context.subscriptions.push(vscode.commands.registerCommand('review.suggestDiff', async (e) => {
		try {
			if (!prManager.activePullRequest) {
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

			if (!vscode.workspace.rootPath) {
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
		vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(e.blobUrl!));
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.copyCommitHash', (e: CommitNode) => {
		vscode.env.clipboard.writeText(e.sha);
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

	context.subscriptions.push(vscode.commands.registerCommand('pr.openDiffGitHub', (uri: string) => {
		vscode.window
			.showWarningMessage('This file is either too large, of an unsupported type, or has only been renamed. Would you like to view it on GitHub?', 'Open in GitHub')
			.then(result => {
				if (result === 'Open in GitHub') {
					vscode.commands.executeCommand('vscode.open', uri);
				}
			});
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
			telemetry.on('pr.deleteLocalPullRequest.failure');
			await vscode.window.showErrorMessage(`Deleting local pull request branch failed: ${error}`);
		} else {
			telemetry.on('pr.deleteLocalPullRequest.success');
			// fire and forget
			vscode.commands.executeCommand('pr.refreshList');
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.create', async () => {
		reviewManager.createPullRequest();
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.createDraft', async () => {
		reviewManager.createPullRequest(true);
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
					telemetry.on('pr.merge.success');
					return newPR;
				} catch (e) {
					vscode.window.showErrorMessage(`Unable to merge pull request. ${formatError(e)}`);
					telemetry.on('pr.merge.failure');
					return newPR;
				}
			}

		});
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.readyForReview', async (pr?: PRNode) => {
		const pullRequest = ensurePR(prManager, pr);
		return vscode.window.showWarningMessage(`Are you sure you want to mark this pull request as ready to review on GitHub?`, { modal: true }, 'Yes').then(async value => {
			let isDraft;
			if (value === 'Yes') {
				try {
					isDraft = await prManager.setReadyForReview(pullRequest);
					vscode.commands.executeCommand('pr.refreshList');
					telemetry.on('pr.readyForReview.success');
					return isDraft;
				} catch (e) {
					vscode.window.showErrorMessage(`Unable to mark pull request as ready to review. ${formatError(e)}`);
					telemetry.on('pr.readyForReview.failure');
					return isDraft;
				}
			}

		});
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.close', async (pr?: PRNode, message?: string) => {
		const pullRequest = ensurePR(prManager, pr);
		return vscode.window.showWarningMessage(`Are you sure you want to close this pull request on GitHub? This will close the pull request without merging.`, 'Yes', 'No').then(async value => {
			if (value === 'Yes') {
				try {
					let newComment: IComment | undefined = undefined;
					if (message) {
						newComment = await prManager.createIssueComment(pullRequest, message);
					}

					let newPR = await prManager.closePullRequest(pullRequest);
					vscode.commands.executeCommand('pr.refreshList');
					_onDidUpdatePR.fire(newPR);
					return newComment;
				} catch (e) {
					vscode.window.showErrorMessage(`Unable to close pull request. ${formatError(e)}`);
					_onDidUpdatePR.fire();
				}
			}

			_onDidUpdatePR.fire();
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
				: vscode.commands.executeCommand('vscode.diff', emptyFileUri, fileChange.parentFilePath, `${fileChange.fileName}`, { preserveFocus: true });
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

	context.subscriptions.push(vscode.commands.registerCommand('pr.configureRemotes', async () => {
		const { name, publisher } = require('../package.json') as { name: string, publisher: string };
		const extensionId = `${publisher}.${name}`;

		return vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${extensionId} remotes`);
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.startReview', async (reply: CommentReply) => {
		telemetry.on('pr.startReview');
		let handler = resolveCommentHandler(reply.thread);

		if (handler) {
			handler.startReview(reply.thread, reply.text);
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.finishReview', async (reply: CommentReply) => {
		telemetry.on('pr.finishReview');
		let handler = resolveCommentHandler(reply.thread);

		if (handler) {
			await handler.finishReview(reply.thread, reply.text);
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.deleteReview', async (reply: CommentReply) => {
		telemetry.on('pr.deleteReview');
		let handler = resolveCommentHandler(reply.thread);

		if (handler) {
			await handler.deleteReview();
		}

		if (!reply.thread.comments.length) {
			reply.thread.dispose();
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.createComment', async (reply: CommentReply) => {
		telemetry.on('pr.createComment');
		let handler = resolveCommentHandler(reply.thread);

		if (handler) {
			handler.createOrReplyComment(reply.thread, reply.text);
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.editComment', async (comment: GHPRComment | TemporaryComment) => {
		telemetry.on('pr.editComment');

		if (comment instanceof GHPRComment) {
			comment.parent.comments = comment.parent.comments.map(cmt => {
				if (cmt instanceof GHPRComment && cmt.commentId === comment.commentId) {
					cmt.mode = vscode.CommentMode.Editing;
				}

				return cmt;
			});
		}

		if (comment instanceof TemporaryComment) {
			comment.parent.comments = comment.parent.comments.map(cmt => {
				if (cmt instanceof TemporaryComment && cmt.id === comment.id) {
					cmt.mode = vscode.CommentMode.Editing;
				}

				return cmt;
			});
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.cancelEditComment', async (comment: GHPRComment | TemporaryComment) => {
		telemetry.on('pr.cancelEditComment');

		if (comment instanceof GHPRComment) {
			comment.parent.comments = comment.parent.comments.map(cmt => {
				if (cmt instanceof GHPRComment && cmt.commentId === comment.commentId) {
					cmt.mode = vscode.CommentMode.Preview;
					cmt.body = cmt._rawComment.body;
				}

				return cmt;
			});
		}

		if (comment instanceof TemporaryComment) {
			comment.parent.comments = comment.parent.comments.map(cmt => {
				if (cmt instanceof TemporaryComment && cmt.id === comment.id) {
					cmt.mode = vscode.CommentMode.Preview;
					cmt.body = cmt.originalBody || cmt.body;
				}

				return cmt;
			});
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.saveComment', async (comment: GHPRComment | TemporaryComment) => {
		telemetry.on('pr.saveComment');
		let handler = resolveCommentHandler(comment.parent);

		if (handler) {
			await handler.editComment(comment.parent, comment);
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.deleteComment', async (comment: GHPRComment | TemporaryComment) => {
		telemetry.on('pr.deleteComment');

		const shouldDelete = await vscode.window.showWarningMessage('Delete comment?', { modal: true }, 'Delete');

		if (shouldDelete === 'Delete') {
			let handler = resolveCommentHandler(comment.parent);

			if (handler) {
				await handler.deleteComment(comment.parent, comment);
			}
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.gotoLine', async () => {
		let line = await vscode.window.showInputBox({
			ignoreFocusOut: true,
			placeHolder: 'GitHub url'
		});

		if (line) {
			let uri = vscode.Uri.parse(line);
			let regex = /blob\/[^/]+\/([^#]*)(#L(\d+))?/g;
			let matches = regex.exec(line);
			if (matches) {
				let fileName = matches[1];
				let opts: vscode.TextDocumentShowOptions = {};

				if (uri.fragment) {
					let lineNumbers = /^L(\d+)(-L(\d+))?/g.exec(uri.fragment);

					if (lineNumbers) {
						let startLineNumber = parseInt(lineNumbers[1]);
						let endLineNumber = parseInt(lineNumbers[3]) || startLineNumber;
						opts = {
							selection: new vscode.Range(startLineNumber - 1, 0, endLineNumber - 1, 0)
						};
					}
				}

				vscode.commands.executeCommand('vscode.open', prManager.repository.rootUri.with({ path: pathLib.join(prManager.repository.rootUri.path, fileName) }), opts);
			}
		}
	}));
}
