/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as path from 'path';
import {
	Comment,
	GitPullRequestCommentThread,
	IdentityRefWithVote,
	PullRequestStatus,
} from 'azure-devops-node-api/interfaces/GitInterfaces';
import { AccountRecentActivityWorkItemModel2, WorkItem } from 'azure-devops-node-api/interfaces/WorkItemTrackingInterfaces';
import * as vscode from 'vscode';
import { onDidUpdatePR } from '../commands';
import Logger from '../common/logger';
import { formatError } from '../common/utils';
import { getNonce, IRequestMessage, WebviewBase } from '../common/webview';
import { SETTINGS_NAMESPACE } from '../constants';
import { User } from './entitlementApi';
import { FolderRepositoryManager } from './folderRepositoryManager';
import { GithubItemStateEnum, MergeMethod, MergeMethodsAvailability, PullRequestCompletion, ReviewState } from './interface';
import { PullRequestModel } from './pullRequestModel';
import { AzdoUserManager } from './userManager';
import { AzdoWorkItem } from './workItem';

export class PullRequestOverviewPanel extends WebviewBase {
	public static ID: string = 'PullRequestOverviewPanel';
	/**
	 * Track the currently panel. Only allow a single panel to exist at a time.
	 */
	public static currentPanel?: PullRequestOverviewPanel;

	protected static readonly _viewType: string = 'PullRequestOverview';
	protected readonly _panel: vscode.WebviewPanel;

	protected _item: PullRequestModel;
	private _repositoryDefaultBranch: string;
	private _existingReviewers: ReviewState[];

	private _changeActivePullRequestListener: vscode.Disposable | undefined;
	private _extensionPath: string;
	private _folderRepositoryManager: FolderRepositoryManager;
	protected _scrollPosition = { x: 0, y: 0 };
	private _workItem: AzdoWorkItem;
	private _userManager: AzdoUserManager;

	public static async createOrShow(
		extensionPath: string,
		folderRepositoryManager: FolderRepositoryManager,
		pr: PullRequestModel,
		workItem: AzdoWorkItem,
		azdoUserManager: AzdoUserManager,
		toTheSide: Boolean = false,
	) {
		const activeColumn = toTheSide
			? vscode.ViewColumn.Beside
			: vscode.window.activeTextEditor
			? vscode.window.activeTextEditor.viewColumn
			: vscode.ViewColumn.One;

		// If we already have a panel, show it.
		// Otherwise, create a new panel.
		if (PullRequestOverviewPanel.currentPanel) {
			PullRequestOverviewPanel.currentPanel._panel.reveal(activeColumn, true);
		} else {
			const title = `Pull Request #${pr.getPullRequestId().toString()}`;
			PullRequestOverviewPanel.currentPanel = new PullRequestOverviewPanel(
				extensionPath,
				activeColumn || vscode.ViewColumn.Active,
				title,
				folderRepositoryManager,
				workItem,
				azdoUserManager,
			);
		}

		await PullRequestOverviewPanel.currentPanel!.update(folderRepositoryManager, pr);
	}

	protected set _currentPanel(panel: PullRequestOverviewPanel | undefined) {
		PullRequestOverviewPanel.currentPanel = panel;
	}

	public static refresh(): void {
		if (this.currentPanel) {
			this.currentPanel.refreshPanel();
		}
	}

	public async refreshPanel(): Promise<void> {
		if (this._panel && this._panel.visible) {
			this.update(this._folderRepositoryManager, this._item);
		}
	}

	protected constructor(
		extensionPath: string,
		column: vscode.ViewColumn,
		title: string,
		folderRepositoryManager: FolderRepositoryManager,
		workItem: AzdoWorkItem,
		azdoUserManager: AzdoUserManager,
	) {
		super();

		this._extensionPath = extensionPath;
		this._folderRepositoryManager = folderRepositoryManager;
		this._workItem = workItem;
		this._userManager = azdoUserManager;

		// Create and show a new webview panel
		this._panel = vscode.window.createWebviewPanel(PullRequestOverviewPanel._viewType, title, column, {
			// Enable javascript in the webview
			enableScripts: true,
			retainContextWhenHidden: true,

			// And restrict the webview to only loading content from our extension's `dist` directory.
			localResourceRoots: [vscode.Uri.file(path.join(this._extensionPath, 'dist'))],
		});

		this._webview = this._panel.webview;
		super.initialize();

		// Listen for when the panel is disposed
		// This happens when the user closes the panel or when the panel is closed programatically
		this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

		this._folderRepositoryManager.onDidChangeActiveIssue(
			_ => {
				if (this._folderRepositoryManager && this._item) {
					const isCurrentlyCheckedOut = this._item.equals(this._folderRepositoryManager.activePullRequest);
					this._postMessage({
						command: 'pr.update-checkout-status',
						isCurrentlyCheckedOut: isCurrentlyCheckedOut,
					});
				}
			},
			null,
			this._disposables,
		);

		this.registerFolderRepositoryListener();

		onDidUpdatePR(
			pr => {
				if (pr) {
					this._item.update(pr);
				}

				this._postMessage({
					command: 'update-state',
					state: this._item.state,
				});
			},
			null,
			this._disposables,
		);
	}

	registerFolderRepositoryListener() {
		this._changeActivePullRequestListener = this._folderRepositoryManager.onDidChangeActivePullRequest(_ => {
			if (this._folderRepositoryManager && this._item) {
				const isCurrentlyCheckedOut = this._item.equals(this._folderRepositoryManager.activePullRequest);
				this._postMessage({
					command: 'pr.update-checkout-status',
					isCurrentlyCheckedOut,
				});
			}
		});
	}

	public async updatePullRequest(pullRequestModel: PullRequestModel): Promise<void> {
		try {
			const result = await Promise.all([
				this._folderRepositoryManager.resolvePullRequest(
					pullRequestModel.remote.owner,
					pullRequestModel.remote.repositoryName,
					pullRequestModel.getPullRequestId(),
				),
				pullRequestModel.getAllActiveThreadsBetweenAllIterations(),
				pullRequestModel.getCommits(),
				this._folderRepositoryManager.getPullRequestRepositoryDefaultBranch(pullRequestModel),
				pullRequestModel.getStatusChecks(),
				this._folderRepositoryManager.getPullRequestRepositoryAccessAndMergeMethods(pullRequestModel),
				pullRequestModel.azdoRepository.getAuthenticatedUser(),
				this.getWorkItemsWithPr(pullRequestModel),
			]);
			const [pullRequest, threads, commits, defaultBranch, status, repositoryAccess, currentUser, workItems] = result;
			const canEditPr = pullRequest?.canEdit();
			const requestedReviewers = pullRequestModel.item.reviewers;
			if (!pullRequest) {
				throw new Error(
					`Fail to resolve Pull Request #${pullRequestModel.getPullRequestId()} in ${pullRequestModel.remote.owner}/${
						pullRequestModel.remote.repositoryName
					}`,
				);
			}

			this._item = pullRequest;
			this._repositoryDefaultBranch = defaultBranch!;
			this._panel.title = `Pull Request #${pullRequestModel.getPullRequestId().toString()}`;

			const isCurrentlyCheckedOut = pullRequestModel.equals(this._folderRepositoryManager.activePullRequest);
			const hasWritePermission = repositoryAccess!.hasWritePermission;
			const mergeMethodsAvailability = repositoryAccess!.mergeMethodsAvailability;
			const canEdit = hasWritePermission || canEditPr;
			const preferredMergeMethod = vscode.workspace
				.getConfiguration(SETTINGS_NAMESPACE)
				.get<MergeMethod>('defaultMergeMethod');
			const defaultMergeMethod = getDefaultMergeMethod(mergeMethodsAvailability, preferredMergeMethod);

			this._existingReviewers = requestedReviewers?.map(this.convertIdentityRefWithVoteToReviewer) ?? [];

			Logger.debug('pr.initialize', PullRequestOverviewPanel.ID);
			this._postMessage({
				command: 'pr.initialize',
				pullrequest: {
					number: pullRequest.getPullRequestId(),
					title: pullRequest.item.title,
					url: pullRequest.url,
					createdAt: pullRequest.item.creationDate,
					body: pullRequest.item.description,
					bodyHTML: pullRequest.item.description,
					labels: pullRequest.item.labels,
					author: {
						id: pullRequest.item.createdBy?.id,
						name: pullRequest.item.createdBy?.displayName,
						avatarUrl: pullRequest.item.createdBy?.['_links']?.['avatar']?.['href'],
						url: pullRequest.item.createdBy?.url,
						email: pullRequest.item.createdBy?.uniqueName,
					},
					state: pullRequest.item.status,
					threads: threads,
					commits: commits,
					isCurrentlyCheckedOut: isCurrentlyCheckedOut,
					base: (pullRequest.base && pullRequest.base.ref) || 'UNKNOWN',
					head: (pullRequest.head && pullRequest.head.ref) || 'UNKNOWN',
					repositoryDefaultBranch: defaultBranch,
					canEdit: canEdit,
					hasWritePermission,
					status: !!status ? status : { statuses: [] },
					mergeable: pullRequest.item.mergeStatus,
					reviewers: this._existingReviewers,
					isDraft: pullRequest.isDraft,
					mergeMethodsAvailability,
					defaultMergeMethod,
					isIssue: false,
					currentUser: currentUser,
					workItems: workItems,
				},
			});
		} catch (e) {
			vscode.window.showErrorMessage(formatError(e));
		}
	}

	public async update(folderRepositoryManager: FolderRepositoryManager, pullRequestModel: PullRequestModel): Promise<void> {
		if (this._folderRepositoryManager !== folderRepositoryManager) {
			this._folderRepositoryManager = folderRepositoryManager;
			if (this._changeActivePullRequestListener) {
				this._changeActivePullRequestListener.dispose();
				this._changeActivePullRequestListener = undefined;
				this.registerFolderRepositoryListener();
			}
		}

		this._postMessage({
			command: 'set-scroll',
			scrollPosition: this._scrollPosition,
		});

		this._panel.webview.html = this.getHtmlForWebview(pullRequestModel.getPullRequestId().toString());

		return this.updatePullRequest(pullRequestModel);
	}

	protected async _onDidReceiveMessage(message: IRequestMessage<any>) {
		const result = await super._onDidReceiveMessage(message);
		if (result !== this.MESSAGE_UNHANDLED) {
			return;
		}
		switch (message.command) {
			case 'pr.checkout':
				return this.checkoutPullRequest(message);
			case 'azdopr.merge':
				return this.mergePullRequest(message);
			case 'pr.deleteBranch':
				return this.deleteBranch(message);
			case 'pr.vote':
				return this.votePullRequest(message);
			case 'pr.complete':
				return this.completePullRequest(message);
			case 'pr.reply-thread':
				return this.replyThread(message);
			case 'pr.change-thread-status':
				return this.changeThreadStatus(message);
			case 'pr.comment':
				return this.createThread(message);
			case 'pr.checkout-default-branch':
				return this.checkoutDefaultBranch(message);
			case 'pr.apply-patch':
				return this.applyPatch(message);
			case 'pr.open-diff':
				return this.openDiff(message);
			case 'pr.associate-workItem':
				return this.associateWorkItemWithPR(message);
			case 'pr.remove-workItem':
				return this.removeWorkItemFromPR(message);
			case 'pr.checkMergeability':
				return this._replyMessage(message, await this._item.getMergability());
			case 'pr.add-reviewers':
				return this.addReviewerToPr(message);
			case 'pr.remove-reviewer':
				return this.removeReviewer(message);
			case 'pr.copy-prlink':
				return this.copyPrLink(message);
			case 'azdopr.close':
				return this.close(message);
			case 'scroll':
				this._scrollPosition = message.args;
				return;
			case 'pr.edit-comment':
				return this.editComment(message);
			case 'pr.edit-description':
				return this.editDescription(message);
			case 'pr.edit-title':
				return this.editTitle(message);
			case 'pr.refresh':
				this.refreshPanel();
				return;
			case 'pr.debug':
				return this.webviewDebug(message);
			case 'alert':
				vscode.window.showErrorMessage(message.args);
				return;
			default:
				return this.MESSAGE_UNHANDLED;
		}
	}

	private async addReviewerToPr(message: IRequestMessage<any>) {
		const disposables: vscode.Disposable[] = [];
		try {
			const quickpick = vscode.window.createQuickPick();
			quickpick.placeholder = 'Search user by name or email address';
			quickpick.items = [];
			quickpick.matchOnDetail = true;
			const userid = await new Promise<string | undefined>((resolve, _) => {
				disposables.push(
					quickpick.onDidChangeValue(async value => {
						quickpick.busy = true;
						const users = await this._userManager.searchIdentities(value);
						if (!!users) {
							quickpick.items = users.map(u => new UserPick(u));
						}
						quickpick.busy = false;
					}),
					quickpick.onDidChangeSelection(value => {
						resolve((value[0] as UserPick).id);
						quickpick.hide();
					}),
					quickpick.onDidHide(() => {
						resolve(undefined);
						quickpick.dispose();
					}),
				);
				quickpick.show();
			});

			if (!!userid) {
				try {
					const review = await this._item.addReviewer(userid, message.args.isRequired);
					this.updateReviewers(review);
					this._replyMessage(message, {
						review: review,
						reviewers: this._existingReviewers,
					});
				} catch (e) {
					this._throwError(message, e);
					vscode.window.showWarningMessage(`Unable add User as reviewer. Error: ${formatError(e)}`);
				}
			}
		} catch (e) {
			this._throwError(message, e);
			vscode.window.showWarningMessage(`Unable add User as reviewer. Error: ${formatError(e)}`);
		} finally {
			disposables.forEach(d => d.dispose());
		}
	}

	// private getReviewersQuickPickItems(assignableUsers: IAccount[], suggestedReviewers: ISuggestedReviewer[] | undefined): vscode.QuickPickItem[] {
	// 	if (!suggestedReviewers) {
	// 		return [];
	// 	}
	// 	// used to track logins that shouldn't be added to pick list
	// 	// e.g. author, existing and already added reviewers
	// 	const skipList: Set<string> = new Set([
	// 		this._item.item.createdBy?.uniqueName!,
	// 		...this._existingReviewers.map(reviewer => reviewer.reviewer.id!)
	// 	]);

	// 	const reviewers: vscode.QuickPickItem[] = [];
	// 	for (const { id, name, isAuthor, isCommenter } of suggestedReviewers) {
	// 		if (skipList.has(id ?? '')) {
	// 			continue;
	// 		}

	// 		const suggestionReason: string =
	// 			isAuthor && isCommenter
	// 				? 'Recently edited and reviewed changes to these files'
	// 				: isAuthor
	// 					? 'Recently edited these files'
	// 					: isCommenter
	// 						? 'Recently reviewed changes to these files'
	// 						: 'Suggested reviewer';

	// 		reviewers.push({
	// 			label: id!,
	// 			description: name,
	// 			detail: suggestionReason
	// 		});
	// 		// this user shouldn't be added later from assignable users list
	// 		skipList.add(id!);
	// 	}

	// 	for (const { id, name } of assignableUsers) {
	// 		if (skipList.has(id!)) {
	// 			continue;
	// 		}

	// 		reviewers.push({
	// 			label: id!,
	// 			description: name
	// 		});
	// 	}

	// 	return reviewers;
	// }

	// private async addReviewers(message: IRequestMessage<void>): Promise<void> {
	// 	try {
	// 		const allAssignableUsers = await this._folderRepositoryManager.getAssignableUsers();
	// 		const assignableUsers = allAssignableUsers[this._item.remote.remoteName];

	// 		const reviewersToAdd = await vscode.window.showQuickPick(
	// 			this.getReviewersQuickPickItems(assignableUsers, this._item.suggestedReviewers),
	// 			{
	// 				canPickMany: true,
	// 				matchOnDescription: true
	// 			}
	// 		);

	// 		if (reviewersToAdd) {
	// 			await this._item.requestReview(reviewersToAdd.map(r => r.label));
	// 			const addedReviewers: ReviewState[] = reviewersToAdd.map(reviewer => {
	// 				return {
	// 					// assumes that suggested reviewers will be a subset of assignable users
	// 					reviewer: assignableUsers.find(r => r.login === reviewer.label)!,
	// 					state: 'REQUESTED'
	// 				};
	// 			});

	// 			this._existingReviewers = this._existingReviewers.concat(addedReviewers);
	// 			this._replyMessage(message, {
	// 				added: addedReviewers
	// 			});
	// 		}
	// 	} catch (e) {
	// 		vscode.window.showErrorMessage(formatError(e));
	// 	}
	// }

	private async removeReviewer(message: IRequestMessage<{ id: string }>): Promise<void> {
		try {
			const reviewerId = message.args.id;
			await this._item.removeReviewer(reviewerId);

			const index = this._existingReviewers.findIndex(reviewer => reviewer.reviewer.id === reviewerId);
			this._existingReviewers.splice(index, 1);

			this._replyMessage(message, {
				review: {},
				reviewers: this._existingReviewers,
			});
		} catch (e) {
			this._throwError(message, e);
			vscode.window.showErrorMessage(
				`Removing Reviewer Failed. reviewerid: ${message.args.id}. Error: ${formatError(e)}`,
			);
		}
	}

	private async getWorkItemsWithPr(pr: PullRequestModel): Promise<WorkItem[]> {
		const refs = await pr.getWorkItemRefs();

		const tasks = refs?.map(r => this._workItem.getWorkItemById(Number.parseInt(r.id!))) ?? [];
		const wts = await Promise.all(tasks);

		return wts.filter((w): w is WorkItem => !!w);
	}

	private async associateWorkItemWithPR(message: IRequestMessage<any>) {
		const disposables: vscode.Disposable[] = [];
		const recentWorkItems = await this._workItem.getRecentWorkItems();
		try {
			const quickpick = vscode.window.createQuickPick();
			quickpick.placeholder = 'Select work item from below list or enter the work item number and press *Enter*';
			quickpick.items = recentWorkItems.map(w => new WorkItemPick(w));
			quickpick.matchOnDetail = true;
			const wid = await new Promise<number | undefined>((resolve, _) => {
				disposables.push(
					quickpick.onDidChangeValue(async value => {
						const id = Number.parseInt(value);
						if (Number.isInteger(id)) {
							if (!quickpick.items.some(w => w.label === value)) {
								quickpick.busy = true;
								const wt = await this._workItem.getWorkItemById(id);
								if (!!wt) {
									quickpick.items = quickpick.items.concat([new WorkItemPick(wt)]);
								}
								quickpick.busy = false;
							}
						}
					}),
					quickpick.onDidChangeSelection(value => {
						resolve(Number.parseInt(value[0].label));
						quickpick.hide();
					}),
					quickpick.onDidHide(() => {
						resolve(undefined);
						quickpick.dispose();
					}),
				);
				quickpick.show();
			});

			if (!!wid) {
				try {
					const wt = await this._workItem.associateWorkItemWithPR(wid, this._item);
					this._replyMessage(message, wt);
				} catch (e) {
					this._throwError(message, e);
					vscode.window.showWarningMessage(`Unable to link PR to workitem. Error: ${formatError(e)}`);
				}
			}
		} catch (e) {
			this._throwError(message, e);
			vscode.window.showWarningMessage(`Unable to link PR to workitem. Error: ${formatError(e)}`);
		} finally {
			disposables.forEach(d => d.dispose());
		}
	}

	private removeWorkItemFromPR(message: IRequestMessage<any>): void {
		const workItem = message.args as WorkItem;

		this._workItem
			.disassociateWorkItemWithPR(workItem, this._item)
			.then(result => {
				if (
					result !== undefined &&
					result?.relations?.find(
						w => w.rel === 'ArtifactLink' && w.url?.toUpperCase() === this._item.item.artifactId?.toUpperCase(),
					) === undefined
				) {
					this._replyMessage(message, { success: true });
				} else {
					vscode.window.showWarningMessage(`Disassociating work item from PR failed.`);
					this._replyMessage(message, { success: false });
				}
			})
			.catch(e => {
				this._throwError(message, e);
				vscode.window.showWarningMessage(`Unable to removing PR link in workitem. Error: ${formatError(e)}`);
			});
	}

	private async applyPatch(
		message: IRequestMessage<{ content: string; commentId: number; threadId: number }>,
	): Promise<void> {
		try {
			const { content, commentId, threadId } = message.args;
			const regex = /```diff\n([\s\S]*)\n```/g;
			const matches = regex.exec(content);

			if (!matches) {
				Logger.appendLine(`Unable to apply patch as regex failed: content: ${content}`, PullRequestOverviewPanel.ID);
				vscode.window.showErrorMessage('Unable to apply patch. The message is not a valid diff format');
				return;
			}

			const tempFilePath = path.join(
				this._folderRepositoryManager.repository.rootUri.path,
				'.git',
				`${threadId}.${commentId}.diff`,
			);

			const encoder = new TextEncoder();
			const tempUri = vscode.Uri.file(tempFilePath);

			await vscode.workspace.fs.writeFile(tempUri, encoder.encode(matches![1]));
			await this._folderRepositoryManager.repository.apply(tempUri.fsPath, false);
			await vscode.workspace.fs.delete(tempUri);
		} catch (e) {
			Logger.appendLine(`Applying patch failed: ${e}`, PullRequestOverviewPanel.ID);
			vscode.window.showErrorMessage(`Applying patch failed: ${formatError(e)}`);
		}
	}

	private async openDiff(message: IRequestMessage<{ thread: GitPullRequestCommentThread }>): Promise<void> {
		try {
			const thread = message.args.thread;
			return PullRequestModel.openDiffFromComment(this._folderRepositoryManager, this._item, thread);
		} catch (e) {
			Logger.appendLine(`Open diff view failed: ${formatError(e)}`, PullRequestOverviewPanel.ID);
		}
	}

	private async deleteBranch(message: IRequestMessage<any>) {
		const branchInfo = await this._folderRepositoryManager.getBranchNameForPullRequest(this._item);
		const actions: (vscode.QuickPickItem & { type: 'upstream' | 'local' | 'remote' })[] = [];

		// if (this._item.isResolved()) {
		// 	const branchHeadRef = this._item.head.ref;

		// 	const isDefaultBranch = this._repositoryDefaultBranch === this._item.head.ref;
		// 	if (!isDefaultBranch) {
		// 		actions.push({
		// 			label: `Delete remote branch ${this._item.remote.remoteName}/${branchHeadRef}`,
		// 			description: `${this._item.remote.normalizedHost}/${this._item.remote.owner}/${this._item.remote.repositoryName}`,
		// 			type: 'upstream',
		// 			picked: true
		// 		});
		// 	}
		// }

		if (branchInfo) {
			const preferredLocalBranchDeletionMethod = vscode.workspace
				.getConfiguration(SETTINGS_NAMESPACE)
				.get<boolean>('defaultDeletionMethod.selectLocalBranch');
			actions.push({
				label: `Delete local branch ${branchInfo.branch}`,
				type: 'local',
				picked: !!preferredLocalBranchDeletionMethod,
			});

			const preferredRemoteDeletionMethod = vscode.workspace
				.getConfiguration(SETTINGS_NAMESPACE)
				.get<boolean>('defaultDeletionMethod.selectRemote');

			if (branchInfo.remote && branchInfo.createdForPullRequest && !branchInfo.remoteInUse) {
				actions.push({
					label: `Delete remote ${branchInfo.remote}, which is no longer used by any other branch`,
					type: 'remote',
					picked: !!preferredRemoteDeletionMethod,
				});
			}
		}

		if (!actions.length) {
			vscode.window.showWarningMessage(
				`There is no longer an upstream or local branch for Pull Request #${this._item.getPullRequestId()}`,
			);
			this._replyMessage(message, {
				cancelled: true,
			});

			return;
		}

		const selectedActions = await vscode.window.showQuickPick(actions, {
			canPickMany: true,
			ignoreFocusOut: true,
		});

		if (selectedActions) {
			const isBranchActive = this._item.equals(this._folderRepositoryManager.activePullRequest);

			const promises = selectedActions.map(async action => {
				switch (action.type) {
					case 'local':
						if (isBranchActive) {
							if (this._folderRepositoryManager.repository.state.workingTreeChanges.length) {
								const response = await vscode.window.showWarningMessage(
									`Your local changes will be lost, do you want to continue?`,
									{ modal: true },
									'Yes',
								);
								if (response === 'Yes') {
									await vscode.commands.executeCommand('git.cleanAll');
								} else {
									return;
								}
							}
							await this._folderRepositoryManager.repository.checkout(this._repositoryDefaultBranch);
						}
						return await this._folderRepositoryManager.repository.deleteBranch(branchInfo!.branch, true);
					case 'remote':
						return this._folderRepositoryManager.repository.removeRemote(branchInfo!.remote!);
				}
			});

			await Promise.all(promises);

			this.refreshPanel();
			vscode.commands.executeCommand('azdopr.refreshList');

			this._postMessage({
				command: 'pr.deleteBranch',
			});
		} else {
			this._replyMessage(message, {
				cancelled: true,
			});
		}
	}

	private checkoutPullRequest(message: IRequestMessage<any>): void {
		vscode.commands.executeCommand('azdopr.pick', this._item).then(
			() => {
				const isCurrentlyCheckedOut = this._item.equals(this._folderRepositoryManager.activePullRequest);
				this._replyMessage(message, { isCurrentlyCheckedOut: isCurrentlyCheckedOut });
			},
			() => {
				const isCurrentlyCheckedOut = this._item.equals(this._folderRepositoryManager.activePullRequest);
				this._replyMessage(message, { isCurrentlyCheckedOut: isCurrentlyCheckedOut });
			},
		);
	}

	private mergePullRequest(
		message: IRequestMessage<{ title: string; description: string; method: 'merge' | 'squash' | 'rebase' }>,
	): void {
		const { title, description, method } = message.args;
		this._folderRepositoryManager
			.mergePullRequest(this._item, title, description, method)
			.then(result => {
				vscode.commands.executeCommand('azdopr.refreshList');

				if (!result.merged) {
					vscode.window.showErrorMessage(`Merging PR failed: ${result.message}`);
				}

				this._replyMessage(message, {
					state: result.merged ? GithubItemStateEnum.Merged : GithubItemStateEnum.Open,
				});
			})
			.catch(e => {
				vscode.window.showErrorMessage(`Unable to merge pull request. ${formatError(e)}`);
				this._throwError(message, {});
			});
	}

	private async checkoutDefaultBranch(message: IRequestMessage<string>): Promise<void> {
		try {
			await this._folderRepositoryManager.checkoutDefaultBranch(message.args);
		} finally {
			// Complete webview promise so that button becomes enabled again
			this._replyMessage(message, {});
		}
	}

	private updateReviewers(review?: IdentityRefWithVote): void {
		if (review) {
			const existingReviewer = this._existingReviewers.find(reviewer => review.id === reviewer.reviewer.id);
			if (existingReviewer) {
				existingReviewer.state = review.vote ?? 0;
				existingReviewer.isRequired = review.isRequired ?? false;
			} else {
				this._existingReviewers.push(this.convertIdentityRefWithVoteToReviewer(review));
			}
		}
	}

	private votePullRequest(message: IRequestMessage<number>): void {
		this._item.submitVote(message.args).then(
			review => {
				this.updateReviewers(review);
				this._replyMessage(message, {
					review: review,
					reviewers: this._existingReviewers,
				});
				//refresh the pr list as this one is approved
				vscode.commands.executeCommand('azdopr.refreshList');
			},
			e => {
				vscode.window.showErrorMessage(`Approving pull request failed. ${formatError(e)}`);

				this._throwError(message, `${formatError(e)}`);
			},
		);
	}

	private createThread(message: IRequestMessage<string>): void {
		this._item.createThread(message.args).then(
			thread => {
				this._replyMessage(message, {
					thread: thread,
				});
			},
			e => {
				vscode.window.showErrorMessage(`Creating thread failed. ${formatError(e)}`);
				this._throwError(message, `${formatError(e)}`);
			},
		);
	}

	private replyThread(message: IRequestMessage<{ text: string; threadId: number }>): void {
		this._item.createCommentOnThread(message.args.threadId, message.args.text).then(
			result => {
				this._replyMessage(message, {
					comment: result,
				});
			},
			e => {
				vscode.window.showErrorMessage(`Commenting on thread failed. ${formatError(e)}`);
				this._throwError(message, `${formatError(e)}`);
			},
		);
	}

	private changeThreadStatus(message: IRequestMessage<{ status: number; threadId: number }>): void {
		this._item.updateThreadStatus(message.args.threadId, message.args.status).then(
			result => {
				this._replyMessage(message, {
					thread: result,
				});
			},
			e => {
				vscode.window.showErrorMessage(`Updating thread status failed. ${formatError(e)}`);
				this._throwError(message, `${formatError(e)}`);
			},
		);
	}

	private editComment(message: IRequestMessage<{ comment: Comment; threadId: number; text: string }>) {
		this.editCommentPromise(message.args.comment, message.args.threadId, message.args.text)
			.then(result => {
				this._replyMessage(message, {
					body: result.content,
					bodyHTML: result.content,
				});
			})
			.catch(e => {
				this._throwError(message, e);
				vscode.window.showErrorMessage(formatError(e));
			});
	}

	private async copyPrLink(_message: IRequestMessage<string>): Promise<void> {
		await vscode.env.clipboard.writeText(this._item.url ?? '');
		vscode.window.showInformationMessage(`Copied link to PR ${this._item.item.title}!`);
	}

	protected editCommentPromise(comment: Comment, threadId: number, text: string): Promise<Comment> {
		return this._item.editThread(text, threadId, comment.id!);
	}

	private close(message: IRequestMessage<string>): void {
		vscode.commands.executeCommand('azdopr.close', this._item, message.args).then(comment => {
			if (comment) {
				this._replyMessage(message, {
					value: comment,
				});
			} else {
				this._throwError(message, 'Close cancelled');
			}
		});
	}

	private editDescription(message: IRequestMessage<{ text: string }>) {
		this._item
			.updatePullRequest(undefined, message.args.text)
			.then(result => {
				this._replyMessage(message, { body: result.description, bodyHTML: result.description });
			})
			.catch(e => {
				this._throwError(message, e);
				vscode.window.showErrorMessage(`Editing description failed: ${formatError(e)}`);
			});
	}
	private editTitle(message: IRequestMessage<{ text: string }>) {
		this._item
			.updatePullRequest(message.args.text, undefined)
			.then(result => {
				this._replyMessage(message, { body: result.description, bodyHTML: result.description });
			})
			.catch(e => {
				this._throwError(message, e);
				vscode.window.showErrorMessage(`Editing title failed: ${formatError(e)}`);
			});
	}

	private completePullRequest(message: IRequestMessage<PullRequestCompletion>) {
		this._item
			.completePullRequest(message.args)
			.then(result => {
				vscode.commands.executeCommand('azdopr.refreshList');

				if (result.closedBy === undefined) {
					vscode.window.showErrorMessage(`Completing PR failed: ${result.mergeFailureMessage}`);
				}

				this._replyMessage(message, {
					state: PullRequestStatus.Completed,
					mergeable: result.mergeStatus,
				});
			})
			.catch(e => {
				vscode.window.showErrorMessage(`Unable to merge pull request. ${formatError(e)}`);
				this._throwError(message, {});
			});
	}

	private convertIdentityRefWithVoteToReviewer(r: IdentityRefWithVote) {
		return {
			reviewer: {
				email: r.uniqueName,
				name: r.displayName,
				avatarUrl: r?.['_links']?.['avatar']?.['href'],
				url: r.reviewerUrl,
				id: r.id,
			},
			state: r.vote ?? 0,
			isRequired: r.isRequired ?? false,
		};
	}

	dispose() {
		this._currentPanel = undefined;

		// Clean up our resources
		this._panel.dispose();

		while (this._disposables.length) {
			const x = this._disposables.pop();
			if (x) {
				x.dispose();
			}
		}

		if (this._changeActivePullRequestListener) {
			this._changeActivePullRequestListener.dispose();
		}
	}

	protected getHtmlForWebview(number: string) {
		const nonce = getNonce();

		const uri = vscode.Uri.file(path.join(this._extensionPath, 'dist', 'webview-pr-description.js'));

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
				<script nonce="${nonce}" src="${this._webview!.asWebviewUri(uri).toString()}"></script>
			</body>
			</html>`;
	}

	public getCurrentTitle(): string {
		return this._panel.title;
	}

	private webviewDebug(message: IRequestMessage<string>): void {
		Logger.debug(message.args, PullRequestOverviewPanel.ID);
	}
}

export function getDefaultMergeMethod(
	methodsAvailability: MergeMethodsAvailability,
	userPreferred: MergeMethod | undefined,
): MergeMethod {
	// Use default merge method specified by user if it is available
	if (userPreferred && methodsAvailability.hasOwnProperty(userPreferred) && methodsAvailability[userPreferred]) {
		return userPreferred;
	}
	const methods: MergeMethod[] = ['Squash', 'NoFastForward', 'Rebase', 'RebaseMerge'];
	// GitHub requires to have at leas one merge method to be enabled; use first available as default
	return methods.find(method => methodsAvailability[method])!;
}

class WorkItemPick implements vscode.QuickPickItem {
	label: string;
	description = '';
	detail: string;

	constructor(workItem: AccountRecentActivityWorkItemModel2 | WorkItem) {
		this.label = String(workItem.id!);
		if ('title' in workItem) {
			this.description = workItem.workItemType!;
			this.detail = workItem.title!;
		} else {
			const wt: WorkItem = workItem;
			this.description = wt.fields?.['System.WorkItemType'] ?? '';
			this.detail = wt.fields?.['System.Title'] ?? '';
		}
	}
}

class UserPick implements vscode.QuickPickItem {
	label: string;
	detail: string;
	id: string;

	constructor(user: User) {
		this.label = user.user.displayName;
		this.detail = user.user.mailAddress;
		this.id = user.id;
	}
}
