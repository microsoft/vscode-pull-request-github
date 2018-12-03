/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as path from 'path';
import * as vscode from 'vscode';
import * as Github from '@octokit/rest';
import { IPullRequestManager, IPullRequestModel, MergePullRequest, PullRequestStateEnum } from './interface';
import { onDidUpdatePR } from '../commands';
import { formatError } from '../common/utils';
import { GitErrorCodes } from '../typings/git';
import { Comment } from '../common/comment';
import { writeFile, unlink } from 'fs';
import Logger from '../common/logger';

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
	/**
	 * Track the currently panel. Only allow a single panel to exist at a time.
	 */
	public static currentPanel: PullRequestOverviewPanel | undefined;

	private static readonly _viewType = 'PullRequestOverview';

	private readonly _panel: vscode.WebviewPanel;
	private readonly _extensionPath: string;
	private _disposables: vscode.Disposable[] = [];
	private _pullRequest: IPullRequestModel;
	private _pullRequestManager: IPullRequestManager;
	private _initialized: boolean;
	private _scrollPosition = { x: 0, y: 0 };

	public static createOrShow(extensionPath: string, pullRequestManager: IPullRequestManager, pullRequestModel: IPullRequestModel) {
		const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;

		// If we already have a panel, show it.
		// Otherwise, create a new panel.
		if (PullRequestOverviewPanel.currentPanel) {
			PullRequestOverviewPanel.currentPanel._panel.reveal(column, true);
		} else {
			const title = `Pull Request #${pullRequestModel.prNumber.toString()}`;
			PullRequestOverviewPanel.currentPanel = new PullRequestOverviewPanel(extensionPath, column || vscode.ViewColumn.One, title, pullRequestManager);
		}

		PullRequestOverviewPanel.currentPanel.update(pullRequestModel);
	}

	public static refresh(): void {
		if (this.currentPanel) {
			this.currentPanel.refreshPanel();
		}
	}

	private constructor(extensionPath: string, column: vscode.ViewColumn, title: string, pullRequestManager: IPullRequestManager) {
		this._extensionPath = extensionPath;
		this._pullRequestManager = pullRequestManager;

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
			if (e.webviewPanel.visible) {
				this.update(this._pullRequest);
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
		this._initialized = false;
		if (this._panel && this._panel.visible) {
			this.update(this._pullRequest);
		}
	}

	public async update(pullRequestModel: IPullRequestModel): Promise<void> {
		this._postMessage({
			command: 'set-scroll',
			scrollPosition: this._scrollPosition,
		});

		if (!pullRequestModel.equals(this._pullRequest) || !this._initialized) {
			this._panel.webview.html = this.getHtmlForWebview(pullRequestModel.prNumber.toString());
			this._pullRequest = pullRequestModel;
			this._initialized = true;
			this._panel.title = `Pull Request #${pullRequestModel.prNumber.toString()}`;

			const isCurrentlyCheckedOut = pullRequestModel.equals(this._pullRequestManager.activePullRequest);
			const canEdit = this._pullRequestManager.canEditPullRequest(this._pullRequest);

			Promise.all(
				[
					this._pullRequestManager.getTimelineEvents(pullRequestModel),
					this._pullRequestManager.getPullRequestRepositoryDefaultBranch(pullRequestModel),
					this._pullRequestManager.getStatusChecks(pullRequestModel)
				]
			).then(result => {
				const [timelineEvents, defaultBranch, status] = result;
				this._postMessage({
					command: 'pr.initialize',
					pullrequest: {
						number: pullRequestModel.prNumber,
						title: pullRequestModel.title,
						url: pullRequestModel.html_url,
						createdAt: pullRequestModel.createdAt,
						body: pullRequestModel.body,
						labels: pullRequestModel.labels,
						author: pullRequestModel.author,
						state: pullRequestModel.state,
						events: timelineEvents,
						isCurrentlyCheckedOut: isCurrentlyCheckedOut,
						base: pullRequestModel.base && pullRequestModel.base.label || 'UNKNOWN',
						head: pullRequestModel.head && pullRequestModel.head.label || 'UNKNOWN',
						commitsCount: pullRequestModel.commitCount,
						repositoryDefaultBranch: defaultBranch,
						canEdit: canEdit,
						status: status
					}
				});
			}).catch(e => {
				vscode.window.showErrorMessage(e);
			});
		}
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
			case 'pr.edit-title':
				return this.editTitle(message);
		}
	}

	private applyPatch(message: IRequestMessage<{ comment: Comment }>): void {
		try {
			const comment = message.args.comment;
			const regex = /```diff\n([\s\S]*)\n```/g;
			const matches = regex.exec(comment.body);
			const tempFilePath = path.resolve(vscode.workspace.rootPath, '.git', `${comment.id}.diff`);
			writeFile(tempFilePath, matches[1], {}, async (writeError) => {
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
		const editCommentPromise = comment.pull_request_review_id !== undefined
			? this._pullRequestManager.editReviewComment(this._pullRequest, comment.id.toString(), text)
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
				const deleteCommentPromise = comment.pull_request_review_id !== undefined
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

	private checkoutPullRequest(message): void {
		vscode.commands.executeCommand('pr.pick', this._pullRequest).then(() => {
			const isCurrentlyCheckedOut = this._pullRequest.equals(this._pullRequestManager.activePullRequest);
			this._replyMessage(message, { isCurrentlyCheckedOut: isCurrentlyCheckedOut });
		}, () => {
			const isCurrentlyCheckedOut = this._pullRequest.equals(this._pullRequestManager.activePullRequest);
			this._replyMessage(message, { isCurrentlyCheckedOut: isCurrentlyCheckedOut });
		});
	}

	private mergePullRequest(message: IRequestMessage<string>): void {
		vscode.commands.executeCommand<MergePullRequest>('pr.merge', this._pullRequest, message.args).then(result => {
			if (!result) {
				this._postMessage({
					command: 'update-state',
					state: PullRequestStateEnum.Open,
				});
				return;
			}

			if (!result.merged) {
				vscode.window.showErrorMessage(`Merging PR failed: ${result.message}`);
			}

			this._postMessage({
				command: 'update-state',
				state: result.merged ? PullRequestStateEnum.Merged : PullRequestStateEnum.Open
			});
		}, (_) => {
			this._postMessage({
				command: 'update-state',
				state: PullRequestStateEnum.Open,
			});
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
		vscode.commands.executeCommand<Github.PullRequestsGetResponse>('pr.approve', this._pullRequest, message.args).then(review => {
			if (review) {
				this._replyMessage(message, {
					value: review
				});
			}

			this._throwError(message, {});
		}, (e) => {
			vscode.window.showErrorMessage(`Approving pull request failed. ${formatError(e)}`);

			this._throwError(message, `${formatError(e)}`);
		});
	}

	private requestChanges(message: IRequestMessage<string>): void {
		vscode.commands.executeCommand<Github.PullRequestsGetResponse>('pr.requestChanges', this._pullRequest, message.args).then(review => {
			if (review) {
				this._replyMessage(message, {
					value: review
				});
			}
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
				<div id="timeline-events" class="discussion" aria-live="polite"></div>
				<details id="status-checks"></details>
				<div id="comment-form" class="comment-form"></div>
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
