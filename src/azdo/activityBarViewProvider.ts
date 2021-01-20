/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { formatError } from '../common/utils';
import { FolderRepositoryManager } from './folderRepositoryManager';
import { GithubItemStateEnum, MergeMethod, PullRequestVote } from './interface';
import { PullRequestModel } from './pullRequestModel';
import * as OctokitTypes from '@octokit/types';
import { getDefaultMergeMethod } from './pullRequestOverview';
import webviewContent from '../../media/activityBar-webviewIndex.js';
import { getNonce, IRequestMessage, WebviewBase } from '../common/webview';
import { IdentityRefWithVote } from 'azure-devops-node-api/interfaces/GitInterfaces';
import { SETTINGS_NAMESPACE } from '../constants';

export class PullRequestViewProvider extends WebviewBase implements vscode.WebviewViewProvider {
	public static readonly viewType = 'azdo:activePullRequest';

	private _view?: vscode.WebviewView;

	private _existingReviewers: IdentityRefWithVote[];

	constructor(
		private readonly _extensionUri: vscode.Uri,
		private readonly _folderRepositoryManager: FolderRepositoryManager,
		private _item: PullRequestModel
	) {
		super();
	}

	public resolveWebviewView(
		webviewView: vscode.WebviewView,
		context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken,
	) {
		this._view = webviewView;
		this._webview = webviewView.webview;
		super.initialize();

		webviewView.webview.options = {
			// Allow scripts in the webview
			enableScripts: true,

			localResourceRoots: [
				this._extensionUri
			]
		};

		webviewView.webview.html = this._getHtmlForWebview();

		this.updatePullRequest(this._item);
	}

	protected async _onDidReceiveMessage(message: IRequestMessage<any>) {
		const result = await super._onDidReceiveMessage(message);
		if (result !== this.MESSAGE_UNHANDLED) {
			return;
		}

		switch (message.command) {
			case 'alert':
				vscode.window.showErrorMessage(message.args);
				return;
			case 'azdopr.close':
				return this.close(message);
			// case 'pr.comment':
			// 	return this.createComment(message);
			case 'azdopr.merge':
				return this.mergePullRequest(message);
			case 'pr.deleteBranch':
				return this.deleteBranch(message);
			case 'pr.approve':
				return this.approvePullRequest(message);
			case 'pr.submit':
				return this.submitReview(message);
		}
	}

	public async updatePullRequest(pullRequestModel: PullRequestModel): Promise<void> {
		return Promise.all([
			this._folderRepositoryManager.resolvePullRequest(
				pullRequestModel.remote.owner,
				pullRequestModel.remote.repositoryName,
				pullRequestModel.getPullRequestId()
			),
			this._folderRepositoryManager.getPullRequestRepositoryAccessAndMergeMethods(pullRequestModel),
		]).then(result => {
			const [pullRequest, repositoryAccess] = result;
			if (!pullRequest) {
				throw new Error(`Fail to resolve Pull Request #${pullRequestModel.getPullRequestId()} in ${pullRequestModel.remote.owner}/${pullRequestModel.remote.repositoryName}`);
			}

			if (!this._view) {
				// If the there is no PR webview, then there is nothing else to update.
				return;
			}

			this._item = pullRequest;
			this._view.title = `${pullRequest.item.title} #${pullRequestModel.getPullRequestId().toString()}`;

			const isCurrentlyCheckedOut = pullRequestModel.equals(this._folderRepositoryManager.activePullRequest);
			const hasWritePermission = repositoryAccess!.hasWritePermission;
			const mergeMethodsAvailability = repositoryAccess!.mergeMethodsAvailability;
			const canEdit = hasWritePermission || this._item.canEdit();
			const preferredMergeMethod = vscode.workspace.getConfiguration(SETTINGS_NAMESPACE).get<MergeMethod>('defaultMergeMethod');
			const defaultMergeMethod = getDefaultMergeMethod(mergeMethodsAvailability, preferredMergeMethod);
			const currentUser = this._folderRepositoryManager.getCurrentUser();
			this._existingReviewers = pullRequest.item.reviewers ?? [];

			this._postMessage({
				command: 'pr.initialize',
				pullrequest: {
					number: pullRequest.getPullRequestId(),
					title: pullRequest.item.title,
					url: pullRequest.url,
					createdAt: pullRequest.item.createdBy,
					body: pullRequest.item.description,
					bodyHTML: pullRequest.item.description,
					labels: pullRequest.item.labels,
					author: {
						login: pullRequest.item.createdBy!.uniqueName!,
						name: pullRequest.item.createdBy?.displayName,
						avatarUrl: pullRequest.item.createdBy?.imageUrl,
						url: pullRequest.item.createdBy?.url
					},
					state: pullRequest.state,
					isCurrentlyCheckedOut: isCurrentlyCheckedOut,
					base: pullRequest.base?.ref ?? 'UNKNOWN',
					head: pullRequest.head?.ref ?? 'UNKNOWN',
					canEdit: canEdit,
					hasWritePermission,
					mergeable: pullRequest.item.mergeStatus,
					isDraft: pullRequest.isDraft,
					status: { statuses: [] },
					events: [],
					mergeMethodsAvailability,
					defaultMergeMethod,
					isIssue: false,
					isAuthor: currentUser.id === pullRequest.item.createdBy?.uniqueName,
					reviewers: this._existingReviewers
				}
			});
		}).catch(e => {
			vscode.window.showErrorMessage(formatError(e));
		});
	}

	private close(message: IRequestMessage<string>): void {
		vscode.commands.executeCommand<OctokitTypes.PullsGetResponseData>('azdopr.close', this._item, message.args).then(comment => {
			if (comment) {
				this._replyMessage(message, {
					value: comment
				});
			}
		});
	}

	// private createComment(message: IRequestMessage<string>) {
	// 	this._item.createCommentOnThread(message.args).then(comment => {
	// 		this._replyMessage(message, {
	// 			value: comment
	// 		});
	// 	});
	// }

	private updateReviewers(review?: IdentityRefWithVote): void {
		if (review) {
			const existingReviewer = this._existingReviewers.find(reviewer => review.uniqueName === reviewer.uniqueName);
			if (existingReviewer) {
				existingReviewer.vote = review.vote;
			} else {
				this._existingReviewers.push(review);
			}
		}
	}

	private approvePullRequest(message: IRequestMessage<string>): void {
		this._item.submitVote(PullRequestVote.APPROVED).then(review => {
			this.updateReviewers(review);
			this._replyMessage(message, {
				review: review,
				reviewers: this._existingReviewers
			});
			//refresh the pr list as this one is approved
			vscode.commands.executeCommand('azdopr.refreshList');
		}, (e) => {
			vscode.window.showErrorMessage(`Approving pull request failed. ${formatError(e)}`);

			this._throwError(message, `${formatError(e)}`);
		});
	}

	private submitReview(message: IRequestMessage<string>): void {
		this._item.createThread(message.args).then(review => {
			// TODO Do I need to update reviewer?
			// this.updateReviewers(review);
			this._replyMessage(message, {
				review: review,
				reviewers: this._existingReviewers
			});
		}, (e) => {
			vscode.window.showErrorMessage(`Submitting review failed. ${formatError(e)}`);
			this._throwError(message, `${formatError(e)}`);
		});
	}

	private async deleteBranch(message: IRequestMessage<any>) {
		const branchInfo = await this._folderRepositoryManager.getBranchNameForPullRequest(this._item);
		const actions: (vscode.QuickPickItem & { type: 'upstream' | 'local' | 'remote' })[] = [];

		if (this._item.isResolved()) {
			const branchHeadRef = this._item.head.ref;

			const defaultBranch = await this._folderRepositoryManager.getPullRequestRepositoryDefaultBranch(this._item);
			const isDefaultBranch = defaultBranch === this._item.head.ref;
			if (!isDefaultBranch) {
				actions.push({
					label: `Delete remote branch ${this._item.remote.remoteName}/${branchHeadRef}`,
					description: `${this._item.remote.normalizedHost}/${this._item.remote.owner}/${this._item.remote.repositoryName}`,
					type: 'upstream',
					picked: true
				});
			}
		}

		if (branchInfo) {
			const preferredLocalBranchDeletionMethod = vscode.workspace.getConfiguration(SETTINGS_NAMESPACE).get<boolean>('defaultDeletionMethod.selectLocalBranch');
			actions.push({
				label: `Delete local branch ${branchInfo.branch}`,
				type: 'local',
				picked: !!preferredLocalBranchDeletionMethod
			});

			const preferredRemoteDeletionMethod = vscode.workspace.getConfiguration(SETTINGS_NAMESPACE).get<boolean>('defaultDeletionMethod.selectRemote');

			if (branchInfo.remote && branchInfo.createdForPullRequest && !branchInfo.remoteInUse) {
				actions.push({
					label: `Delete remote ${branchInfo.remote}, which is no longer used by any other branch`,
					type: 'remote',
					picked: !!preferredRemoteDeletionMethod
				});
			}
		}

		if (!actions.length) {
			vscode.window.showWarningMessage(`There is no longer an upstream or local branch for Pull Request #${this._item.getPullRequestId()}`);
			this._replyMessage(message, {
				cancelled: true
			});

			return;
		}

		const selectedActions = await vscode.window.showQuickPick(actions, {
			canPickMany: true,
			ignoreFocusOut: true
		});

		if (selectedActions) {
			const isBranchActive = this._item.equals(this._folderRepositoryManager.activePullRequest);

			const promises = selectedActions.map(async (action) => {
				switch (action.type) {
					case 'local':
						if (isBranchActive) {
							if (this._folderRepositoryManager.repository.state.workingTreeChanges.length) {
								const response = await vscode.window.showWarningMessage(`Your local changes will be lost, do you want to continue?`, { modal: true }, 'Yes');
								if (response === 'Yes') {
									await vscode.commands.executeCommand('git.cleanAll');
								} else {
									return;
								}
							}
							const defaultBranch = await this._folderRepositoryManager.getPullRequestRepositoryDefaultBranch(this._item);
							await this._folderRepositoryManager.repository.checkout(defaultBranch);
						}
						return await this._folderRepositoryManager.repository.deleteBranch(branchInfo!.branch, true);
					case 'remote':
						return this._folderRepositoryManager.repository.removeRemote(branchInfo!.remote!);
				}
			});

			await Promise.all(promises);

			vscode.commands.executeCommand('azdopr.refreshList');

			this._postMessage({
				command: 'pr.deleteBranch'
			});
		} else {
			this._replyMessage(message, {
				cancelled: true
			});
		}
	}

	private async mergePullRequest(message: IRequestMessage<{ title: string, description: string, method: 'merge' | 'squash' | 'rebase' }>): Promise<void> {
		const { title, description, method } = message.args;
		const confirmation = await vscode.window.showInformationMessage('Merge this pull request?', { modal: true }, 'Yes');
		if (confirmation !== 'Yes') {
			this._replyMessage(message, { state: GithubItemStateEnum.Open });
			return;
		}

		this._folderRepositoryManager.mergePullRequest(this._item, title, description, method).then(result => {
			vscode.commands.executeCommand('azdopr.refreshList');

			if (!result.merged) {
				vscode.window.showErrorMessage(`Merging PR failed: ${result.message}`);
			}

			this._replyMessage(message, {
				state: result.merged ? GithubItemStateEnum.Merged : GithubItemStateEnum.Open
			});
		}).catch(e => {
			vscode.window.showErrorMessage(`Unable to merge pull request. ${formatError(e)}`);
			this._throwError(message, {});
		});
	}

	private _getHtmlForWebview() {
		const nonce = getNonce();

		return `<!DOCTYPE html>
		<html lang="en">
		<head>
			<meta charset="UTF-8">
			<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src vscode-resource: https:; script-src 'nonce-${nonce}'; style-src vscode-resource: 'unsafe-inline' http: https: data:;">
			<meta name="viewport" content="width=device-width, initial-scale=1.0">

			<title>Active Pull Request</title>
		</head>
		<body>
			<div id="app"></div>
			<script nonce="${nonce}">${webviewContent}</script>
		</body>
		</html>`;
	}
}