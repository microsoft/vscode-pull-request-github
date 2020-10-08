/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as path from 'path';
import * as vscode from 'vscode';
import * as OctokitTypes from '@octokit/types';
import { ILabel } from './interface';
import { formatError } from '../common/utils';
import { IComment } from '../common/comment';
import Logger from '../common/logger';
import { DescriptionNode } from '../view/treeNodes/descriptionNode';
import { FolderRepositoryManager } from './folderRepositoryManager';
import { IssueModel } from './issueModel';
import webviewContent from '../../media/webviewIndex.js';

export interface IRequestMessage<T> {
	req: string;
	command: string;
	args: T;
}

export interface IReplyMessage {
	seq?: string;
	err?: any;
	res?: any;
}

export class IssueOverviewPanel {
	public static ID: string = 'PullRequestOverviewPanel';
	/**
	 * Track the currently panel. Only allow a single panel to exist at a time.
	 */
	public static currentPanel?: IssueOverviewPanel;

	protected static readonly _viewType: string = 'IssueOverview';

	protected readonly _panel: vscode.WebviewPanel;
	private readonly _extensionPath: string;
	protected _disposables: vscode.Disposable[] = [];
	protected _descriptionNode: DescriptionNode;
	protected _item: IssueModel;
	protected _folderRepositoryManager: FolderRepositoryManager;
	protected _scrollPosition = { x: 0, y: 0 };
	private _waitForReady: Promise<void>;
	private _onIsReady: vscode.EventEmitter<void> = new vscode.EventEmitter();

	protected readonly MESSAGE_UNHANDLED: string = 'message not handled';

	public static async createOrShow(extensionPath: string, folderRepositoryManager: FolderRepositoryManager, issue: IssueModel, descriptionNode: DescriptionNode, toTheSide: Boolean = false) {
		const activeColumn = toTheSide ?
			vscode.ViewColumn.Beside :
			vscode.window.activeTextEditor ?
				vscode.window.activeTextEditor.viewColumn :
				vscode.ViewColumn.One;

		// If we already have a panel, show it.
		// Otherwise, create a new panel.
		if (IssueOverviewPanel.currentPanel) {
			IssueOverviewPanel.currentPanel._panel.reveal(activeColumn, true);
		} else {
			const title = `Issue #${issue.number.toString()}`;
			IssueOverviewPanel.currentPanel = new IssueOverviewPanel(extensionPath, activeColumn || vscode.ViewColumn.Active, title, folderRepositoryManager, descriptionNode);
		}

		await IssueOverviewPanel.currentPanel!.update(folderRepositoryManager, issue, descriptionNode);
	}

	public static refresh(): void {
		if (this.currentPanel) {
			this.currentPanel.refreshPanel();
		}
	}

	protected constructor(extensionPath: string, column: vscode.ViewColumn, title: string, folderRepositoryManager: FolderRepositoryManager, descriptionNode: DescriptionNode, type: string = IssueOverviewPanel._viewType) {
		this._extensionPath = extensionPath;
		this._folderRepositoryManager = folderRepositoryManager;
		this._descriptionNode = descriptionNode;

		// Create and show a new webview panel
		this._panel = vscode.window.createWebviewPanel(type, title, column, {
			// Enable javascript in the webview
			enableScripts: true,
			retainContextWhenHidden: true,

			// And restrict the webview to only loading content from our extension's `media` directory.
			localResourceRoots: [
				vscode.Uri.file(path.join(this._extensionPath, 'media'))
			]
		});

		this._waitForReady = new Promise(resolve => {
			const disposable = this._onIsReady.event(() => {
				disposable.dispose();
				resolve();
			});
		});

		// Listen for when the panel is disposed
		// This happens when the user closes the panel or when the panel is closed programatically
		this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

		// Handle messages from the webview
		this._panel.webview.onDidReceiveMessage(async message => {
			await this._onDidReceiveMessage(message);
		}, null, this._disposables);

		this._folderRepositoryManager.onDidChangeActiveIssue(_ => {
			if (this._folderRepositoryManager && this._item) {
				const isCurrentlyCheckedOut = this._item.equals(this._folderRepositoryManager.activeIssue);
				this._postMessage({
					command: 'pr.update-checkout-status',
					isCurrentlyCheckedOut: isCurrentlyCheckedOut
				});
			}
		}, null, this._disposables);
	}

	public async refreshPanel(): Promise<void> {
		if (this._panel && this._panel.visible) {
			this.update(this._folderRepositoryManager, this._item, this._descriptionNode);
		}
	}

	public async updateIssue(issueModel: IssueModel, descriptionNode: DescriptionNode): Promise<void> {
		return Promise.all([
			this._folderRepositoryManager.resolveIssue(
				issueModel.remote.owner,
				issueModel.remote.repositoryName,
				issueModel.number
			),
			issueModel.getIssueTimelineEvents(),
			this._folderRepositoryManager.getPullRequestRepositoryDefaultBranch(issueModel),
		]).then(result => {
			const [issue, timelineEvents, defaultBranch] = result;
			if (!issue) {
				throw new Error(`Fail to resolve issue #${issueModel.number} in ${issueModel.remote.owner}/${issueModel.remote.repositoryName}`);
			}

			this._item = issue;
			this._panel.title = `Pull Request #${issueModel.number.toString()}`;

			Logger.debug('pr.initialize', IssueOverviewPanel.ID);
			this._postMessage({
				command: 'pr.initialize',
				pullrequest: {
					number: this._item.number,
					title: this._item.title,
					url: this._item.html_url,
					createdAt: this._item.createdAt,
					body: this._item.body,
					bodyHTML: this._item.bodyHTML,
					labels: this._item.item.labels,
					author: {
						login: this._item.author.login,
						name: this._item.author.name,
						avatarUrl: this._item.userAvatar,
						url: this._item.author.url
					},
					state: this._item.state,
					events: timelineEvents,
					repositoryDefaultBranch: defaultBranch,
					canEdit: true,
					status: status ? status : { statuses: [] },
					isIssue: true
				}
			});
		}).catch(e => {
			vscode.window.showErrorMessage(formatError(e));
		});
	}

	public async update(foldersManager: FolderRepositoryManager, issueModel: IssueModel, descriptionNode: DescriptionNode): Promise<void> {
		this._folderRepositoryManager = foldersManager;
		this._descriptionNode = descriptionNode;
		this._postMessage({
			command: 'set-scroll',
			scrollPosition: this._scrollPosition,
		});

		this._panel.webview.html = this.getHtmlForWebview(issueModel.number.toString());
		return this.updateIssue(issueModel, descriptionNode);
	}

	protected async _postMessage(message: any) {
		// Without the following ready check, we can end up in a state where the message handler in the webview
		// isn't ready for any of the messages we post.
		await this._waitForReady;
		this._panel.webview.postMessage({
			res: message
		});
	}

	protected async _replyMessage(originalMessage: IRequestMessage<any>, message: any) {
		const reply: IReplyMessage = {
			seq: originalMessage.req,
			res: message
		};
		this._panel.webview.postMessage(reply);
	}

	protected async _throwError(originalMessage: IRequestMessage<any>, error: any) {
		const reply: IReplyMessage = {
			seq: originalMessage.req,
			err: error
		};
		this._panel.webview.postMessage(reply);
	}

	protected async _onDidReceiveMessage(message: IRequestMessage<any>) {
		switch (message.command) {
			case 'alert':
				vscode.window.showErrorMessage(message.args);
				return;
			case 'pr.close':
				return this.close(message);
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
			case 'pr.edit-title':
				return this.editTitle(message);
			case 'pr.refresh':
				this.refreshPanel();
				return;
			case 'pr.add-labels':
				return this.addLabels(message);
			case 'pr.remove-label':
				return this.removeLabel(message);
			case 'pr.debug':
				return this.webviewDebug(message);
			case 'ready':
				this._onIsReady.fire();
				return;
			default:
				return this.MESSAGE_UNHANDLED;
		}
	}

	private async addLabels(message: IRequestMessage<void>): Promise<void> {
		try {
			let newLabels: ILabel[] = [];
			async function getLabelOptions(folderRepoManager: FolderRepositoryManager, issue: IssueModel): Promise<vscode.QuickPickItem[]> {
				const allLabels = await folderRepoManager.getLabels(issue);
				newLabels = allLabels.filter(l => !issue.item.labels.some(label => label.name === l.name));

				return newLabels.map(label => {
					return {
						label: label.name
					};
				});
			}

			const labelsToAdd = await vscode.window.showQuickPick(await getLabelOptions(this._folderRepositoryManager, this._item), { canPickMany: true });

			if (labelsToAdd && labelsToAdd.length) {
				await this._item.addLabels(labelsToAdd.map(r => r.label));
				const addedLabels: ILabel[] = labelsToAdd.map(label => newLabels.find(l => l.name === label.label)!);

				this._item.item.labels = this._item.item.labels.concat(...addedLabels);

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
			await this._item.removeLabel(message.args);

			const index = this._item.item.labels.findIndex(label => label.name === message.args);
			this._item.item.labels.splice(index, 1);

			this._replyMessage(message, {});
		} catch (e) {
			vscode.window.showErrorMessage(formatError(e));
		}
	}

	private webviewDebug(message: IRequestMessage<string>): void {
		Logger.debug(message.args, IssueOverviewPanel.ID);
	}

	private editDescription(message: IRequestMessage<{ text: string }>) {
		this._item.edit({ body: message.args.text }).then(result => {
			this._replyMessage(message, { body: result.body, bodyHTML: result.bodyHTML });
		}).catch(e => {
			this._throwError(message, e);
			vscode.window.showErrorMessage(`Editing description failed: ${formatError(e)}`);
		});

	}
	private editTitle(message: IRequestMessage<{ text: string }>) {
		this._item.edit({ title: message.args.text }).then(result => {
			this._replyMessage(message, { text: result.title });
		}).catch(e => {
			this._throwError(message, e);
			vscode.window.showErrorMessage(`Editing title failed: ${formatError(e)}`);
		});
	}

	protected editCommentPromise(comment: IComment, text: string): Promise<IComment> {
		return this._item.editIssueComment(comment, text);
	}

	private editComment(message: IRequestMessage<{ comment: IComment, text: string }>) {
		this.editCommentPromise(message.args.comment, message.args.text).then(result => {
			this._replyMessage(message, {
				body: result.body,
				bodyHTML: result.bodyHTML
			});
		}).catch(e => {
			this._throwError(message, e);
			vscode.window.showErrorMessage(formatError(e));
		});
	}

	protected deleteCommentPromise(comment: IComment): Promise<void> {
		return this._item.deleteIssueComment(comment.id.toString());
	}

	private deleteComment(message: IRequestMessage<IComment>) {
		vscode.window.showWarningMessage('Are you sure you want to delete this comment?', { modal: true }, 'Delete').then(value => {
			if (value === 'Delete') {
				this.deleteCommentPromise(message.args).then(result => {
					this._replyMessage(message, {});
				}).catch(e => {
					this._throwError(message, e);
					vscode.window.showErrorMessage(formatError(e));
				});
			}
		});
	}

	private close(message: IRequestMessage<string>): void {
		vscode.commands.executeCommand<OctokitTypes.PullsGetResponseData>('pr.close', this._item, message.args).then(comment => {
			if (comment) {
				this._replyMessage(message, {
					value: comment
				});
			}
		});
	}

	private createComment(message: IRequestMessage<string>) {
		this._item.createIssueComment(message.args).then(comment => {
			this._replyMessage(message, {
				value: comment
			});
		});
	}

	protected set _currentPanel(panel: IssueOverviewPanel | undefined) {
		IssueOverviewPanel.currentPanel = panel;
	}

	public dispose() {
		this._currentPanel = undefined;

		// Clean up our resources
		this._panel.dispose();

		while (this._disposables.length) {
			const x = this._disposables.pop();
			if (x) {
				x.dispose();
			}
		}
	}

	protected getHtmlForWebview(number: string) {
		const nonce = getNonce();

		return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src vscode-resource: https:; script-src 'nonce-${nonce}'; style-src vscode-resource: 'unsafe-inline' http: https: data:;">

				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<title>Pull Request #${number}</title>
			</head>
			<body class="${process.platform}">
				<div id=app></div>
				<script nonce="${nonce}">${webviewContent}</script>
			</body>
			</html>`;
	}

	public getCurrentTitle(): string {
		return this._panel.title;
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
