/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as path from 'path';
import * as vscode from 'vscode';
import * as Github from '@octokit/rest';
import { PullRequestStateEnum, ReviewEvent, ReviewState, ILabel } from './interface';
import { onDidUpdatePR } from '../commands';
import { formatError } from '../common/utils';
import { GitErrorCodes } from '../git/api';
import { Comment } from '../common/comment';
import { writeFile, unlink } from 'fs';
import Logger from '../common/logger';
import { DescriptionNode } from '../view/treeNodes/descriptionNode';
import { TreeNode, Revealable } from '../view/treeNodes/treeNode';
import { PullRequestManager } from './pullRequestManager';
import { PullRequestModel } from './pullRequestModel';
import { TimelineEvent, isReviewEvent } from '../common/timelineEvent';

interface IRequestMessage<T> {
	req: string;
	command: string;
	args: T;
}

interface IReplyMessage {
	seq?: string;
	err?: any;
	res?: any;
}

export class PullRequestOverviewPanel {
	public static ID: string = 'PullRequestOverviewPanel';
	/**
	 * Track the currently panel. Only allow a single panel to exist at a time.
	 */
	public static currentPanel?: PullRequestOverviewPanel;

	private static readonly _viewType = 'PullRequestOverview';

	private readonly _panel: vscode.WebviewPanel;
	private readonly _extensionPath: string;
	private _disposables: vscode.Disposable[] = [];
	private _descriptionNode: DescriptionNode;
	private _pullRequest: PullRequestModel;
	private _pullRequestManager: PullRequestManager;
	private _scrollPosition = { x: 0, y: 0 };
	private _existingReviewers: ReviewState[];

	public static createOrShow(extensionPath: string, pullRequestManager: PullRequestManager, pullRequestModel: PullRequestModel, descriptionNode: DescriptionNode, toTheSide: Boolean = false) {
		let activeColumn = toTheSide ?
							vscode.ViewColumn.Beside :
							vscode.window.activeTextEditor ?
								vscode.window.activeTextEditor.viewColumn :
								vscode.ViewColumn.One;

		// If we already have a panel, show it.
		// Otherwise, create a new panel.
		if (PullRequestOverviewPanel.currentPanel) {
			PullRequestOverviewPanel.currentPanel._panel.reveal(activeColumn, true);
		} else {
			const title = `Pull Request #${pullRequestModel.prNumber.toString()}`;
			PullRequestOverviewPanel.currentPanel = new PullRequestOverviewPanel(extensionPath, activeColumn || vscode.ViewColumn.Active, title, pullRequestManager, descriptionNode);
		}

		PullRequestOverviewPanel.currentPanel!.update(pullRequestModel, descriptionNode);
	}

	public static refresh(): void {
		if (this.currentPanel) {
			this.currentPanel.refreshPanel();
		}
	}

	private constructor(extensionPath: string, column: vscode.ViewColumn, title: string, pullRequestManager: PullRequestManager, descriptionNode: DescriptionNode) {
		this._extensionPath = extensionPath;
		this._pullRequestManager = pullRequestManager;
		this._descriptionNode = descriptionNode;

		// Create and show a new webview panel
		this._panel = vscode.window.createWebviewPanel(PullRequestOverviewPanel._viewType, title, column, {
			// Enable javascript in the webview
			enableScripts: true,

			// And restric the webview to only loading content from our extension's `media` directory.
			localResourceRoots: [
				vscode.Uri.file(path.join(this._extensionPath, 'media'))
			]
		});

		// Listen for when the panel is disposed
		// This happens when the user closes the panel or when the panel is closed programatically
		this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

		// Listen for changes to panel visibility, if the webview comes into view resubmit data
		this._panel.onDidChangeViewState(e => {
			if (e.webviewPanel.visible && this._pullRequest) {
				this.update(this._pullRequest, this._descriptionNode);
			}
		}, this, this._disposables);

		// Handle messages from the webview
		this._panel.webview.onDidReceiveMessage(async message => {
			await this._onDidReceiveMessage(message);
		}, null, this._disposables);

		this._pullRequestManager.onDidChangeActivePullRequest(_ => {
			if (this._pullRequestManager && this._pullRequest) {
				const isCurrentlyCheckedOut = this._pullRequest.equals(this._pullRequestManager.activePullRequest);
				this._postMessage({
					command: 'pr.update-checkout-status',
					isCurrentlyCheckedOut: isCurrentlyCheckedOut
				});
			}
		}, null, this._disposables);

		onDidUpdatePR(pr => {
			if (pr) {
				this._pullRequest.update(pr);
			}

			this._postMessage({
				command: 'update-state',
				state: this._pullRequest.state,
			});
		}, null, this._disposables);
	}

	public async refreshPanel(): Promise<void> {
		if (this._panel && this._panel.visible) {
			this.update(this._pullRequest, this._descriptionNode);
		}
	}

	private parseReviewers(pullRequestModel: PullRequestModel, timelineEvents: TimelineEvent[]): ReviewState[] {
		const reviewEvents = timelineEvents.filter(isReviewEvent);
		let reviewers: ReviewState[] = [];
		const seen = new Map<string, boolean>();

		// Do not show the author in the reviewer list
		seen.set(pullRequestModel.author.login, true);

		for (let i = reviewEvents.length -1; i >= 0; i--) {
			const reviewer = reviewEvents[i].user;
			if (!seen.get(reviewer.login)) {
				seen.set(reviewer.login, true);
				reviewers.push({
					reviewer: reviewer,
					state: reviewEvents[i].state
				});
			}
		}

		pullRequestModel.prItem.reviewRequests.forEach(request => {
			reviewers.push({
				reviewer: request,
				state: 'REQUESTED'
			});
		});

		// Put completed reviews before review requests and alphabetize each section
		reviewers = reviewers.sort((a, b) => {
			if (a.state === 'REQUESTED' && b.state !== 'REQUESTED') {
				return 1;
			}

			if (b.state === 'REQUESTED' && a.state !== 'REQUESTED') {
				return -1;
			}

			return a.reviewer.login.toLowerCase() < b.reviewer.login.toLowerCase() ? -1 : 1;
		});

		this._existingReviewers = reviewers;
		return reviewers;
	}

	public async update(pullRequestModel: PullRequestModel, descriptionNode: DescriptionNode): Promise<void> {
		this._descriptionNode = descriptionNode;
		this._postMessage({
			command: 'set-scroll',
			scrollPosition: this._scrollPosition,
		});

		this._panel.webview.html = this.getHtmlForWebview(pullRequestModel.prNumber.toString());

		Promise.all([
			this._pullRequestManager.resolvePullRequest(
				pullRequestModel.remote.owner,
				pullRequestModel.remote.repositoryName,
				pullRequestModel.prNumber
			),
			this._pullRequestManager.getTimelineEvents(pullRequestModel),
			this._pullRequestManager.getPullRequestRepositoryDefaultBranch(pullRequestModel),
			this._pullRequestManager.getStatusChecks(pullRequestModel)
		]).then(result => {
			const [pullRequest, timelineEvents, defaultBranch, status] = result;
			if (!pullRequest) {
				throw new Error(`Fail to resolve Pull Request #${pullRequestModel.prNumber} in ${pullRequestModel.remote.owner}/${pullRequestModel.remote.repositoryName}`);
			}

			this._pullRequest = pullRequest;
			this._panel.title = `Pull Request #${pullRequestModel.prNumber.toString()}`;

			const isCurrentlyCheckedOut = pullRequestModel.equals(this._pullRequestManager.activePullRequest);
			const canEdit = this._pullRequestManager.canEditPullRequest(this._pullRequest);
			const defaultMergeMethod = vscode.workspace.getConfiguration('githubPullRequests').get<string>('defaultMergeMethod');
			const supportsGraphQl = pullRequestModel.githubRepository.supportsGraphQl;

			this._postMessage({
				command: 'pr.initialize',
				pullrequest: {
					number: this._pullRequest.prNumber,
					title: this._pullRequest.title,
					url: this._pullRequest.html_url,
					createdAt: this._pullRequest.createdAt,
					body: this._pullRequest.body,
					bodyHTML: this._pullRequest.bodyHTML,
					labels: this._pullRequest.prItem.labels,
					author: this._pullRequest.author,
					state: this._pullRequest.state,
					events: timelineEvents,
					isCurrentlyCheckedOut: isCurrentlyCheckedOut,
					base: this._pullRequest.base && this._pullRequest.base.label || 'UNKNOWN',
					head: this._pullRequest.head && this._pullRequest.head.label || 'UNKNOWN',
					repositoryDefaultBranch: defaultBranch,
					canEdit: canEdit,
					status: status,
					mergeable: this._pullRequest.prItem.mergeable,
					reviewers: this.parseReviewers(this._pullRequest, timelineEvents),
					defaultMergeMethod,
					supportsGraphQl
				}
			});
		}).catch(e => {
			vscode.window.showErrorMessage(formatError(e));
		});
	}

	private async _postMessage(message: any) {
		this._panel.webview.postMessage({
			res: message
		});
	}

	private async _replyMessage(originalMessage: IRequestMessage<any>, message: any) {
		const reply: IReplyMessage = {
			seq: originalMessage.req,
			res: message
		};
		this._panel.webview.postMessage(reply);
	}

	private async _throwError(originalMessage: IRequestMessage<any>, error: any) {
		const reply: IReplyMessage = {
			seq: originalMessage.req,
			err: error
		};
		this._panel.webview.postMessage(reply);
	}

	private async _onDidReceiveMessage(message: IRequestMessage<any>) {
		switch (message.command) {
			case 'alert':
				vscode.window.showErrorMessage(message.args);
				return;
			case 'pr.checkout':
				return this.checkoutPullRequest(message);
			case 'pr.merge':
				return this.mergePullRequest(message);
			case 'pr.close':
				return this.closePullRequest(message);
			case 'pr.approve':
				return this.approvePullRequest(message);
			case 'pr.request-changes':
				return this.requestChanges(message);
			case 'pr.submit':
				return this.submitReview(message);
			case 'pr.checkout-default-branch':
				return this.checkoutDefaultBranch(message.args);
			case 'pr.comment':
				return this.createComment(message);
			case 'scroll':
				this._scrollPosition = message.args;
				return;
			case 'pr.edit-comment':
				return this.editComment(message);
			case 'pr.delete-comment':
				return this.deleteComment(message);
			case 'pr.edit-description':
				return this.editDescription(message);
			case 'pr.apply-patch':
				return this.applyPatch(message);
			case 'pr.open-diff':
				return this.openDiff(message);
			case 'pr.edit-title':
				return this.editTitle(message);
			case 'pr.refresh':
				this.refreshPanel();
				return;
			case 'pr.add-reviewers':
				return this.addReviewers(message);
			case 'pr.remove-reviewer':
				return this.removeReviewer(message);
			case 'pr.add-labels':
				return this.addLabels(message);
			case 'pr.remove-label':
				return this.removeLabel(message);
		}
	}

	private async addReviewers(message: IRequestMessage<void>): Promise<void> {
		try {
			const allMentionableUsers = await this._pullRequestManager.getMentionableUsers();
			const mentionableUsers = allMentionableUsers[this._pullRequest.remote.remoteName];
			const newReviewers = mentionableUsers
				.filter(user =>
					!this._existingReviewers.some(reviewer => reviewer.reviewer.login === user.login)
					&& user.login !== this._pullRequest.author.login);

			const reviewersToAdd = await vscode.window.showQuickPick(newReviewers.map(reviewer => {
				return {
					label: reviewer.login,
					details: reviewer.name
				};
			}), {
				canPickMany: true
			});

			if (reviewersToAdd) {
				await this._pullRequestManager.requestReview(this._pullRequest, reviewersToAdd.map(r => r.label));
				const addedReviewers: ReviewState[] = reviewersToAdd.map(reviewer => {
					return {
						reviewer: newReviewers.find(r => r.login === reviewer.label)!,
						state: 'REQUESTED'
					};
				});

				this._existingReviewers = this._existingReviewers.concat(addedReviewers);
				this._replyMessage(message, {
					added: addedReviewers
				});
			}
		} catch (e) {
			vscode.window.showErrorMessage(formatError(e));
		}
	}

	private async removeReviewer(message: IRequestMessage<string>): Promise<void> {
		try {
			await this._pullRequestManager.deleteRequestedReview(this._pullRequest, message.args);

			const index = this._existingReviewers.findIndex(reviewer => reviewer.reviewer.login === message.args);
			this._existingReviewers.splice(index, 1);

			this._replyMessage(message, { });
		} catch (e) {
			vscode.window.showErrorMessage(formatError(e));
		}
	}

	private async addLabels(message: IRequestMessage<void>): Promise<void> {
		try {
			const allLabels = await this._pullRequestManager.getLabels(this._pullRequest);
			const newLabels = allLabels
				.filter(l => !this._pullRequest.prItem.labels.some(label => label.name === l.name));

			const labelsToAdd = await vscode.window.showQuickPick(newLabels.map(label => {
				return {
					label: label.name
				};
			}), {
				canPickMany: true
			});

			if (labelsToAdd) {
				await this._pullRequestManager.addLabels(this._pullRequest, labelsToAdd.map(r => r.label));
				const addedLabels: ILabel[] = labelsToAdd.map(label =>  newLabels.find(l => l.name === label.label)!);

				this._pullRequest.prItem.labels.concat(...addedLabels);

				this._replyMessage(message, {
					added: addedLabels
				});
			}
		} catch (e) {
			vscode.window.showErrorMessage(formatError(e));
		}
	}

	private async removeLabel(message: IRequestMessage<string>): Promise<void> {
		try {
			await this._pullRequestManager.removeLabel(this._pullRequest, message.args);

			const index = this._pullRequest.prItem.labels.findIndex(label => label.name === message.args);
			this._pullRequest.prItem.labels.splice(index, 1);

			this._replyMessage(message, { });
		} catch (e) {
			vscode.window.showErrorMessage(formatError(e));
		}
	}

	private applyPatch(message: IRequestMessage<{ comment: Comment }>): void {
		try {
			const comment = message.args.comment;
			const regex = /```diff\n([\s\S]*)\n```/g;
			const matches = regex.exec(comment.body);
			if (!vscode.workspace.rootPath) {
				throw new Error('Current workspace rootpath is undefined.');
			}
			const tempFilePath = path.resolve(vscode.workspace.rootPath, '.git', `${comment.id}.diff`);
			writeFile(tempFilePath, matches![1], {}, async (writeError) => {
				if (writeError) {
					throw writeError;
				}

				try {
					await this._pullRequestManager.repository.apply(tempFilePath);

					// Need to mark conversation as resolved
					unlink(tempFilePath, (err) => {
						if (err) {
							throw err;
						}

						this._replyMessage(message, { });
					});
				} catch (e) {
					Logger.appendLine(`Applying patch failed: ${e}`);
					vscode.window.showErrorMessage(`Applying patch failed: ${formatError(e)}`);
				}
			});
		} catch (e) {
			Logger.appendLine(`Applying patch failed: ${e}`);
			vscode.window.showErrorMessage(`Applying patch failed: ${formatError(e)}`);
		}
	}

	private openDiff(message: IRequestMessage<{ comment: Comment }>): void {
		try {
			const comment = message.args.comment;
			const prContainer = this._descriptionNode.parent;

			if ((prContainer as TreeNode | Revealable<TreeNode>).revealComment) {
				(prContainer as TreeNode | Revealable<TreeNode>).revealComment!(comment);
			}
		} catch (e) {
			Logger.appendLine(`Open diff view failed: ${formatError(e)}`, PullRequestOverviewPanel.ID);
		}
	}

	private editDescription(message: IRequestMessage<{ text: string }>) {
		this._pullRequestManager.editPullRequest(this._pullRequest, { body: message.args.text }).then(result => {
			this._replyMessage(message, { text: result.body });
		}).catch(e => {
			this._throwError(message, e);
			vscode.window.showErrorMessage(`Editing description failed: ${formatError(e)}`);
		});

	}
	private editTitle(message: IRequestMessage<{ text: string }>) {
		this._pullRequestManager.editPullRequest(this._pullRequest, { title: message.args.text }).then(result => {
			this._replyMessage(message, { text: result.title });
		}).catch(e => {
			this._throwError(message, e);
			vscode.window.showErrorMessage(`Editing title failed: ${formatError(e)}`);
		});
	}

	private editComment(message: IRequestMessage<{ comment: Comment, text: string }>) {
		const { comment, text } = message.args;
		const editCommentPromise = comment.pullRequestReviewId !== undefined
			? this._pullRequestManager.editReviewComment(this._pullRequest, comment, text)
			: this._pullRequestManager.editIssueComment(this._pullRequest, comment.id.toString(), text);

		editCommentPromise.then(result => {
			this._replyMessage(message, {
				text: result.body
			});
		}).catch(e => {
			this._throwError(message, e);
			vscode.window.showErrorMessage(formatError(e));
		});
	}

	private deleteComment(message: IRequestMessage<Comment>) {
		const comment = message.args;
		vscode.window.showWarningMessage('Are you sure you want to delete this comment?', { modal: true }, 'Delete').then(value => {
			if (value === 'Delete') {
				const deleteCommentPromise = comment.pullRequestReviewId !== undefined
					? this._pullRequestManager.deleteReviewComment(this._pullRequest, comment.id.toString())
					: this._pullRequestManager.deleteIssueComment(this._pullRequest, comment.id.toString());

				deleteCommentPromise.then(result => {
					this._replyMessage(message, { });
				}).catch(e => {
					this._throwError(message, e);
					vscode.window.showErrorMessage(formatError(e));
				});
			}
		});
	}

	private checkoutPullRequest(message: IRequestMessage<any>): void {
		vscode.commands.executeCommand('pr.pick', this._pullRequest).then(() => {
			const isCurrentlyCheckedOut = this._pullRequest.equals(this._pullRequestManager.activePullRequest);
			this._replyMessage(message, { isCurrentlyCheckedOut: isCurrentlyCheckedOut });
		}, () => {
			const isCurrentlyCheckedOut = this._pullRequest.equals(this._pullRequestManager.activePullRequest);
			this._replyMessage(message, { isCurrentlyCheckedOut: isCurrentlyCheckedOut });
		});
	}

	private mergePullRequest(message: IRequestMessage<{ title: string, description: string, method: 'merge' | 'squash' | 'rebase' }>): void {
		const { title, description, method } = message.args;
		this._pullRequestManager.mergePullRequest(this._pullRequest, title, description, method).then(result => {
			vscode.commands.executeCommand('pr.refreshList');

			if (!result.merged) {
				vscode.window.showErrorMessage(`Merging PR failed: ${result.message}`);
			}

			this._replyMessage(message, {
				state: result.merged ? PullRequestStateEnum.Merged : PullRequestStateEnum.Open
			});
		}).catch(e => {
			vscode.window.showErrorMessage(`Unable to merge pull request. ${formatError(e)}`);
			this._throwError(message, {});
		});
	}

	private closePullRequest(message: IRequestMessage<string>): void {
		vscode.commands.executeCommand<Github.PullRequestsGetResponse>('pr.close', this._pullRequest, message.args).then(comment => {
			if (comment) {
				this._replyMessage(message, {
					value: comment
				});
			}
		});
	}

	private async checkoutDefaultBranch(branch: string): Promise<void> {
		try {
			// This should be updated for multi-root support and consume the git extension API if possible
			const branchObj = await this._pullRequestManager.repository.getBranch('@{-1}');

			if (branch === branchObj.name) {
				await this._pullRequestManager.repository.checkout(branch);
			} else {
				const didCheckout = await vscode.commands.executeCommand('git.checkout');
				if (!didCheckout) {
					this._postMessage({
						command: 'pr.enable-exit'
					});
				}
			}
		} catch (e) {
			if (e.gitErrorCode) {
				// for known git errors, we should provide actions for users to continue.
				if (e.gitErrorCode === GitErrorCodes.DirtyWorkTree) {
					vscode.window.showErrorMessage('Your local changes would be overwritten by checkout, please commit your changes or stash them before you switch branches');
					this._postMessage({
						command: 'pr.enable-exit'
					});
					return;
				}
			}

			vscode.window.showErrorMessage(`Exiting failed: ${e}`);
			this._postMessage({
				command: 'pr.enable-exit'
			});
		}
	}

	private createComment(message: IRequestMessage<string>) {
		this._pullRequestManager.createIssueComment(this._pullRequest, message.args).then(comment => {
			this._replyMessage(message, {
				value: comment
			});
		});
	}

	private approvePullRequest(message: IRequestMessage<string>): void {
		vscode.commands.executeCommand<Github.PullRequestsGetResponse>('pr.approve', this._pullRequest, message.args).then(_ => {
			this.refreshPanel();
		}, (e) => {
			vscode.window.showErrorMessage(`Approving pull request failed. ${formatError(e)}`);

			this._throwError(message, `${formatError(e)}`);
		});
	}

	private requestChanges(message: IRequestMessage<string>): void {
		vscode.commands.executeCommand<Github.PullRequestsGetResponse>('pr.requestChanges', this._pullRequest, message.args).then(_ => {
			this.refreshPanel();
		}, (e) => {
			vscode.window.showErrorMessage(`Requesting changes failed. ${formatError(e)}`);
			this._throwError(message, `${formatError(e)}`);
		});
	}

	private submitReview(message: IRequestMessage<string>): void {
		this._pullRequestManager.submitReview(this._pullRequest, ReviewEvent.Comment, message.args).then(review => {
			this.refreshPanel();
		}, (e) => {
			vscode.window.showErrorMessage(`Requesting changes failed. ${formatError(e)}`);
			this._throwError(message, `${formatError(e)}`);
		});
	}

	public dispose() {
		PullRequestOverviewPanel.currentPanel = undefined;

		// Clean up our resources
		this._panel.dispose();

		while (this._disposables.length) {
			const x = this._disposables.pop();
			if (x) {
				x.dispose();
			}
		}
	}

	private getHtmlForWebview(number: string) {
		const scriptPathOnDisk = vscode.Uri.file(path.join(this._extensionPath, 'media', 'index.js'));
		const scriptUri = scriptPathOnDisk.with({ scheme: 'vscode-resource' });
		const nonce = getNonce();

		return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src vscode-resource: https:; script-src 'nonce-${nonce}'; style-src vscode-resource: 'unsafe-inline' http: https: data:;">

				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<title>Pull Request #${number}</title>
			</head>
			<body>
				<script nonce="${nonce}" src="${scriptUri}"></script>
				<div id="title" class="title"></div>
				<div id="sidebar">
					<div id="reviewers" class="section"></div>
					<div id="labels" class="section"></div>
				</div>
				<div id="main">
					<div id="description"></div>
					<div id="timeline-events" class="discussion" aria-live="polite"></div>
					<div id="status-checks"></div>
					<div id="comment-form" class="comment-form"></div>
				</div>
			</body>
			</html>`;
	}
}

function getNonce() {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}
