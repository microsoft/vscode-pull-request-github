/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import { CloseResult } from '../../common/views';
import { openPullRequestOnGitHub } from '../commands';
import { COPILOT_ACCOUNTS, IComment } from '../common/comment';
import { emojify, ensureEmojis } from '../common/emoji';
import Logger from '../common/logger';
import { PR_SETTINGS_NAMESPACE, WEBVIEW_REFRESH_INTERVAL } from '../common/settingKeys';
import { ITelemetry } from '../common/telemetry';
import { CommentEvent, EventType, ReviewStateValue, TimelineEvent } from '../common/timelineEvent';
import { asPromise, formatError } from '../common/utils';
import { getNonce, IRequestMessage, WebviewBase } from '../common/webview';
import { FolderRepositoryManager } from './folderRepositoryManager';
import { GithubItemStateEnum, IAccount, IMilestone, IProject, IProjectItem, RepoAccessAndMergeMethods } from './interface';
import { IssueModel } from './issueModel';
import { getAssigneesQuickPickItems, getLabelOptions, getMilestoneFromQuickPick, getProjectFromQuickPick } from './quickPicks';
import { isInCodespaces, vscodeDevPrLink } from './utils';
import { ChangeAssigneesReply, DisplayLabel, Issue, ProjectItemsReply, SubmitReviewReply } from './views';

export class IssueOverviewPanel<TItem extends IssueModel = IssueModel> extends WebviewBase {
	public static ID: string = 'IssueOverviewPanel';
	/**
	 * Track the currently panel. Only allow a single panel to exist at a time.
	 */
	public static currentPanel?: IssueOverviewPanel;

	private static readonly _viewType: string = 'IssueOverview';

	protected readonly _panel: vscode.WebviewPanel;
	protected _item: TItem;
	protected _folderRepositoryManager: FolderRepositoryManager;
	protected _scrollPosition = { x: 0, y: 0 };

	public static async createOrShow(
		telemetry: ITelemetry,
		extensionUri: vscode.Uri,
		folderRepositoryManager: FolderRepositoryManager,
		issue: IssueModel,
		toTheSide: Boolean = false,
	) {
		await ensureEmojis(folderRepositoryManager.context);
		const activeColumn = toTheSide
			? vscode.ViewColumn.Beside
			: vscode.window.activeTextEditor
				? vscode.window.activeTextEditor.viewColumn
				: vscode.ViewColumn.One;

		// If we already have a panel, show it.
		// Otherwise, create a new panel.
		if (IssueOverviewPanel.currentPanel) {
			IssueOverviewPanel.currentPanel._panel.reveal(activeColumn, true);
		} else {
			const title = `Issue #${issue.number.toString()}`;
			IssueOverviewPanel.currentPanel = new IssueOverviewPanel(
				telemetry,
				extensionUri,
				activeColumn || vscode.ViewColumn.Active,
				title,
				folderRepositoryManager,
			);
		}

		await IssueOverviewPanel.currentPanel!.update(folderRepositoryManager, issue);
	}

	public static refresh(): void {
		if (this.currentPanel) {
			this.currentPanel.refreshPanel();
		}
	}

	protected setPanelTitle(title: string): void {
		try {
			this._panel.title = title;
		} catch (e) {
			// The webview can be disposed at the time that we try to set the title if the user has closed
			// it while it's still loading.
		}
	}

	protected constructor(
		protected readonly _telemetry: ITelemetry,
		protected readonly _extensionUri: vscode.Uri,
		column: vscode.ViewColumn,
		title: string,
		folderRepositoryManager: FolderRepositoryManager,
		private readonly type: string = IssueOverviewPanel._viewType,
		iconSubpath?: {
			light: string,
			dark: string,
		}
	) {
		super();
		this._folderRepositoryManager = folderRepositoryManager;

		// Create and show a new webview panel
		this._panel = this._register(vscode.window.createWebviewPanel(type, title, column, {
			// Enable javascript in the webview
			enableScripts: true,
			retainContextWhenHidden: true,

			// And restrict the webview to only loading content from our extension's `dist` directory.
			localResourceRoots: [vscode.Uri.joinPath(_extensionUri, 'dist')],
			enableFindWidget: true
		}));

		if (iconSubpath) {
			this._panel.iconPath = {
				dark: vscode.Uri.joinPath(_extensionUri, iconSubpath.dark),
				light: vscode.Uri.joinPath(_extensionUri, iconSubpath.light)
			};
		}

		this._webview = this._panel.webview;
		super.initialize();

		// Listen for when the panel is disposed
		// This happens when the user closes the panel or when the panel is closed programmatically
		this._register(this._panel.onDidDispose(() => this.dispose()));

		this._register(this._folderRepositoryManager.onDidChangeActiveIssue(
			_ => {
				if (this._folderRepositoryManager && this._item) {
					const isCurrentlyCheckedOut = this._item.equals(this._folderRepositoryManager.activeIssue);
					this._postMessage({
						command: 'pr.update-checkout-status',
						isCurrentlyCheckedOut: isCurrentlyCheckedOut,
					});
				}
			}));

		this._register(folderRepositoryManager.credentialStore.onDidUpgradeSession(() => {
			this.updateItem(this._item);
		}));

		this._register(this._panel.onDidChangeViewState(e => this.onDidChangeViewState(e)));
		this.lastRefreshTime = new Date();
		this.pollForUpdates(true);
		this._register(vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(`${PR_SETTINGS_NAMESPACE}.${WEBVIEW_REFRESH_INTERVAL}`)) {
				this.pollForUpdates(this._panel.visible, true);
			}
		}));
		this._register({ dispose: () => clearTimeout(this.timeout) });

	}

	private getRefreshInterval(): number {
		return vscode.workspace.getConfiguration().get<number>(`${PR_SETTINGS_NAMESPACE}.${WEBVIEW_REFRESH_INTERVAL}`) || 60;
	}

	protected onDidChangeViewState(e: vscode.WebviewPanelOnDidChangeViewStateEvent): void {
		if (e.webviewPanel.visible) {
			this.pollForUpdates(!!this._item, true);
		}
	}

	private timeout: NodeJS.Timeout | undefined = undefined;
	private lastRefreshTime: Date;
	private pollForUpdates(isVisible: boolean, refreshImmediately: boolean = false): void {
		clearTimeout(this.timeout);
		const refresh = async () => {
			const previousRefreshTime = this.lastRefreshTime;
			this.lastRefreshTime = await this._item.getLastUpdateTime(previousRefreshTime);
			if (this.lastRefreshTime.getTime() > previousRefreshTime.getTime()) {
				return this.refreshPanel();
			}
		};

		if (refreshImmediately) {
			refresh();
		}
		const webview = isVisible || vscode.window.tabGroups.all.find(group => group.activeTab?.input instanceof vscode.TabInputWebview && group.activeTab.input.viewType.endsWith(this.type));
		const timeoutDuration = 1000 * (webview ? this.getRefreshInterval() : (5 * 60));
		this.timeout = setTimeout(async () => {
			await refresh();
			this.pollForUpdates(this._panel.visible);
		}, timeoutDuration);
	}

	public async refreshPanel(): Promise<void> {
		if (this._panel && this._panel.visible) {
			await this.update(this._folderRepositoryManager, this._item);
		}
	}

	protected continueOnGitHub() {
		return isInCodespaces();
	}

	protected getInitializeContext(currentUser: IAccount, issue: IssueModel, timelineEvents: TimelineEvent[], repositoryAccess: RepoAccessAndMergeMethods, viewerCanEdit: boolean, assignableUsers: IAccount[]): Issue {
		const hasWritePermission = repositoryAccess!.hasWritePermission;
		const canEdit = hasWritePermission || viewerCanEdit;
		const labels = issue.item.labels.map(label => ({
			...label,
			displayName: emojify(label.name)
		}));

		const context: Issue = {
			owner: issue.remote.owner,
			repo: issue.remote.repositoryName,
			number: issue.number,
			title: issue.title,
			titleHTML: issue.titleHTML,
			url: issue.html_url,
			createdAt: issue.createdAt,
			body: issue.body,
			bodyHTML: issue.bodyHTML,
			labels: labels,
			author: issue.author,
			state: issue.state,
			events: timelineEvents,
			continueOnGitHub: this.continueOnGitHub(),
			canEdit,
			hasWritePermission,
			isIssue: true,
			projectItems: issue.item.projectItems,
			milestone: issue.milestone,
			assignees: issue.assignees ?? [],
			isEnterprise: issue.githubRepository.remote.isEnterprise,
			isDarkTheme: vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark,
			canAssignCopilot: assignableUsers.find(user => COPILOT_ACCOUNTS[user.login]) !== undefined,
			reactions: issue.item.reactions,
			isAuthor: issue.author.login === currentUser.login,
		};

		return context;
	}

	protected async updateItem(issueModel: TItem): Promise<void> {
		try {
			const [
				issue,
				timelineEvents,
				repositoryAccess,
				viewerCanEdit,
				assignableUsers,
				currentUser
			] = await Promise.all([
				this._folderRepositoryManager.resolveIssue(
					issueModel.remote.owner,
					issueModel.remote.repositoryName,
					issueModel.number,
				),
				issueModel.getIssueTimelineEvents(issueModel),
				this._folderRepositoryManager.getPullRequestRepositoryAccessAndMergeMethods(issueModel),
				issueModel.canEdit(),
				this._folderRepositoryManager.getAssignableUsers(),
				this._folderRepositoryManager.getCurrentUser(),
			]);

			if (!issue) {
				throw new Error(
					`Fail to resolve issue #${issueModel.number} in ${issueModel.remote.owner}/${issueModel.remote.repositoryName}`,
				);
			}

			this._item = issue as TItem;
			this.setPanelTitle(`Issue #${issueModel.number.toString()}`);

			Logger.debug('pr.initialize', IssueOverviewPanel.ID);
			this._postMessage({
				command: 'pr.initialize',
				pullrequest: this.getInitializeContext(currentUser, issue, timelineEvents, repositoryAccess, viewerCanEdit, assignableUsers[this._item.remote.remoteName] ?? []),
			});

		} catch (e) {
			vscode.window.showErrorMessage(`Error updating issue description: ${formatError(e)}`);
		}
	}

	public async update(foldersManager: FolderRepositoryManager, issueModel: TItem): Promise<void> {
		this._folderRepositoryManager = foldersManager;
		this._postMessage({
			command: 'set-scroll',
			scrollPosition: this._scrollPosition,
		});

		this._panel.webview.html = this.getHtmlForWebview();
		return this.updateItem(issueModel);
	}

	protected override async _onDidReceiveMessage(message: IRequestMessage<any>) {
		const result = await super._onDidReceiveMessage(message);
		if (result !== this.MESSAGE_UNHANDLED) {
			return;
		}

		switch (message.command) {
			case 'alert':
				vscode.window.showErrorMessage(message.args);
				return;
			case 'pr.close':
				return this.close(message);
			case 'pr.submit':
				return this.submitReviewMessage(message);
			case 'scroll':
				this._scrollPosition = message.args.scrollPosition;
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
			case 'pr.change-assignees':
				return this.changeAssignees(message);
			case 'pr.remove-milestone':
				return this.removeMilestone(message);
			case 'pr.add-milestone':
				return this.addMilestone(message);
			case 'pr.change-projects':
				return this.changeProjects(message);
			case 'pr.remove-project':
				return this.removeProject(message);
			case 'pr.add-assignee-yourself':
				return this.addAssigneeYourself(message);
			case 'pr.add-assignee-copilot':
				return this.addAssigneeCopilot(message);
			case 'pr.copy-prlink':
				return this.copyItemLink();
			case 'pr.copy-vscodedevlink':
				return this.copyVscodeDevLink();
			case 'pr.openOnGitHub':
				return openPullRequestOnGitHub(this._item, (this._item as any)._telemetry);
			case 'pr.debug':
				return this.webviewDebug(message);
			default:
				return this.MESSAGE_UNHANDLED;
		}
	}

	protected async submitReviewMessage(message: IRequestMessage<string>) {
		const comment = await this._item.createIssueComment(message.args);
		const commentedEvent: CommentEvent = {
			...comment,
			event: EventType.Commented
		};
		const allEvents = await this._getTimeline();
		const reply: SubmitReviewReply = {
			events: allEvents,
			reviewedEvent: commentedEvent,
		};
		this.tryScheduleCopilotRefresh(comment.body);
		return this._replyMessage(message, reply);
	}

	private _scheduledRefresh: Promise<void> | undefined;
	protected async tryScheduleCopilotRefresh(commentBody: string, reviewType?: ReviewStateValue) {
		if (!this._scheduledRefresh) {
			this._scheduledRefresh = this.doScheduleCopilotRefresh(commentBody, reviewType)
				.finally(() => {
					this._scheduledRefresh = undefined;
				});
		}
	}

	private async doScheduleCopilotRefresh(commentBody: string, reviewType?: ReviewStateValue) {
		if (!COPILOT_ACCOUNTS[this._item.author.login]) {
			return;
		}

		if (!commentBody.includes('@copilot') && !commentBody.includes('@Copilot') && reviewType !== 'CHANGES_REQUESTED') {
			return;
		}

		const initialTimeline = await this._getTimeline();
		const delays = [250, 500, 1000, 2000];

		for (const delay of delays) {
			await new Promise(resolve => setTimeout(resolve, delay));
			if (this._isDisposed) {
				return;
			}

			try {
				const currentTimeline = await this._getTimeline();

				// Check if we have any new CopilotStarted events
				if (currentTimeline.length > initialTimeline.length) {
					// Found a new CopilotStarted event, refresh and stop
					this.refreshPanel();
					return;
				}
			} catch (error) {
				// If timeline fetch fails, continue with the next retry
				Logger.warn(`Failed to fetch timeline during Copilot refresh retry: ${error}`, IssueOverviewPanel.ID);
			}
		}

		// If no new CopilotStarted events were found after all retries, still refresh once
		if (!this._isDisposed) {
			this.refreshPanel();
		}
	}

	private async addLabels(message: IRequestMessage<void>): Promise<void> {
		const quickPick = vscode.window.createQuickPick<(vscode.QuickPickItem & { name: string })>();
		try {
			let newLabels: DisplayLabel[] = [];

			quickPick.busy = true;
			quickPick.canSelectMany = true;
			quickPick.show();
			quickPick.items = await (getLabelOptions(this._folderRepositoryManager, this._item.item.labels, this._item.remote.owner, this._item.remote.repositoryName).then(options => {
				newLabels = options.newLabels;
				return options.labelPicks;
			}));
			quickPick.selectedItems = quickPick.items.filter(item => item.picked);

			quickPick.busy = false;
			const acceptPromise = asPromise<void>(quickPick.onDidAccept).then(() => {
				return quickPick.selectedItems;
			});
			const hidePromise = asPromise<void>(quickPick.onDidHide);
			const labelsToAdd = await Promise.race<readonly (vscode.QuickPickItem & { name: string })[] | void>([acceptPromise, hidePromise]);
			quickPick.busy = true;
			quickPick.enabled = false;

			if (labelsToAdd) {
				await this._item.setLabels(labelsToAdd.map(r => r.name));
				const addedLabels: DisplayLabel[] = labelsToAdd.map(label => newLabels.find(l => l.name === label.name)!);

				await this._replyMessage(message, {
					added: addedLabels,
				});
			}
		} catch (e) {
			vscode.window.showErrorMessage(formatError(e));
		} finally {
			quickPick.hide();
			quickPick.dispose();
		}
	}

	private async removeLabel(message: IRequestMessage<string>): Promise<void> {
		try {
			await this._item.removeLabel(message.args);
			this._replyMessage(message, {});
		} catch (e) {
			vscode.window.showErrorMessage(formatError(e));
		}
	}

	private webviewDebug(message: IRequestMessage<string>): void {
		Logger.debug(message.args, IssueOverviewPanel.ID);
	}

	private editDescription(message: IRequestMessage<{ text: string }>) {
		this._item
			.edit({ body: message.args.text })
			.then(result => {
				this._replyMessage(message, { body: result.body, bodyHTML: result.bodyHTML });
			})
			.catch(e => {
				this._throwError(message, e);
				vscode.window.showErrorMessage(`Editing description failed: ${formatError(e)}`);
			});
	}
	private editTitle(message: IRequestMessage<{ text: string }>) {
		return this._item
			.edit({ title: message.args.text })
			.then(result => {
				return this._replyMessage(message, { titleHTML: result.titleHTML });
			})
			.catch(e => {
				this._throwError(message, e);
				vscode.window.showErrorMessage(`Editing title failed: ${formatError(e)}`);
			});
	}

	protected _getTimeline(): Promise<TimelineEvent[]> {
		return this._item.getIssueTimelineEvents(this._item);
	}

	private async changeAssignees(message: IRequestMessage<void>): Promise<void> {
		const quickPick = vscode.window.createQuickPick<vscode.QuickPickItem & { user?: IAccount }>();

		try {
			quickPick.busy = true;
			quickPick.canSelectMany = true;
			quickPick.matchOnDescription = true;
			quickPick.show();
			quickPick.items = await getAssigneesQuickPickItems(this._folderRepositoryManager, undefined, this._item.remote.remoteName, this._item.assignees ?? [], this._item);
			quickPick.selectedItems = quickPick.items.filter(item => item.picked);

			quickPick.busy = false;
			const acceptPromise = asPromise<void>(quickPick.onDidAccept).then(() => {
				return quickPick.selectedItems.filter(item => item.user) as (vscode.QuickPickItem & { user: IAccount })[] | undefined;
			});
			const hidePromise = asPromise<void>(quickPick.onDidHide);
			const allAssignees = await Promise.race<(vscode.QuickPickItem & { user: IAccount })[] | void>([acceptPromise, hidePromise]);
			quickPick.busy = true;
			quickPick.enabled = false;

			if (allAssignees) {
				const newAssignees: IAccount[] = allAssignees.map(item => item.user);
				await this._item.replaceAssignees(newAssignees);
				const events = await this._getTimeline();
				const reply: ChangeAssigneesReply = {
					assignees: newAssignees,
					events
				};
				await this._replyMessage(message, reply);
			}
		} catch (e) {
			vscode.window.showErrorMessage(formatError(e));
		} finally {
			quickPick.hide();
			quickPick.dispose();
		}
	}


	private async addMilestone(message: IRequestMessage<void>): Promise<void> {
		return getMilestoneFromQuickPick(this._folderRepositoryManager, this._item.githubRepository, this._item.milestone, (milestone) => this.updateMilestone(milestone, message));
	}

	private async updateMilestone(milestone: IMilestone | undefined, message: IRequestMessage<void>) {
		if (!milestone) {
			return this.removeMilestone(message);
		}
		await this._item.updateMilestone(milestone.id);
		this._replyMessage(message, {
			added: milestone,
		});
	}

	private async removeMilestone(message: IRequestMessage<void>): Promise<void> {
		try {
			await this._item.updateMilestone('null');
			this._replyMessage(message, {});
		} catch (e) {
			vscode.window.showErrorMessage(formatError(e));
		}
	}

	private async changeProjects(message: IRequestMessage<void>): Promise<void> {
		return getProjectFromQuickPick(this._folderRepositoryManager, this._item.githubRepository, this._item.item.projectItems?.map(item => item.project), (project) => this.updateProjects(project, message));
	}

	private async updateProjects(projects: IProject[] | undefined, message: IRequestMessage<void>) {
		let newProjects: IProjectItem[] = [];
		if (projects) {
			newProjects = (await this._item.updateProjects(projects)) ?? [];
		}
		const projectItemsReply: ProjectItemsReply = {
			projectItems: newProjects,
		};
		return this._replyMessage(message, projectItemsReply);
	}

	private async removeProject(message: IRequestMessage<IProjectItem>): Promise<void> {
		await this._item.removeProjects([message.args]);
		return this._replyMessage(message, {});
	}

	private async addAssigneeYourself(message: IRequestMessage<void>): Promise<void> {
		try {
			const currentUser = await this._folderRepositoryManager.getCurrentUser();
			const alreadyAssigned = this._item.assignees?.find(user => user.login === currentUser.login);
			if (!alreadyAssigned) {
				const newAssignees = (this._item.assignees ?? []).concat(currentUser);
				await this._item.replaceAssignees(newAssignees);
			}
			const events = await this._getTimeline();
			const reply: ChangeAssigneesReply = {
				assignees: this._item.assignees ?? [],
				events
			};
			this._replyMessage(message, reply);
		} catch (e) {
			vscode.window.showErrorMessage(formatError(e));
		}
	}

	private async addAssigneeCopilot(message: IRequestMessage<void>): Promise<void> {
		try {
			const copilotUser = (await this._folderRepositoryManager.getAssignableUsers())[this._item.remote.remoteName].find(user => COPILOT_ACCOUNTS[user.login]);
			if (copilotUser) {
				const newAssignees = (this._item.assignees ?? []).concat(copilotUser);
				await this._item.replaceAssignees(newAssignees);
			}
			const events = await this._getTimeline();
			const reply: ChangeAssigneesReply = {
				assignees: this._item.assignees ?? [],
				events
			};
			this._replyMessage(message, reply);
		} catch (e) {
			vscode.window.showErrorMessage(formatError(e));
		}
	}

	private async copyItemLink(): Promise<void> {
		return vscode.env.clipboard.writeText(this._item.html_url);
	}

	private async copyVscodeDevLink(): Promise<void> {
		return vscode.env.clipboard.writeText(vscodeDevPrLink(this._item));
	}

	protected editCommentPromise(comment: IComment, text: string): Promise<IComment> {
		return this._item.editIssueComment(comment, text);
	}

	private editComment(message: IRequestMessage<{ comment: IComment; text: string }>) {
		this.editCommentPromise(message.args.comment, message.args.text)
			.then(result => {
				this._replyMessage(message, {
					body: result.body,
					bodyHTML: result.bodyHTML,
				});
			})
			.catch(e => {
				this._throwError(message, e);
				vscode.window.showErrorMessage(formatError(e));
			});
	}

	protected deleteCommentPromise(comment: IComment): Promise<void> {
		return this._item.deleteIssueComment(comment.id.toString());
	}

	private deleteComment(message: IRequestMessage<IComment>) {
		vscode.window
			.showWarningMessage(vscode.l10n.t('Are you sure you want to delete this comment?'), { modal: true }, 'Delete')
			.then(value => {
				if (value === 'Delete') {
					this.deleteCommentPromise(message.args)
						.then(_ => {
							this._replyMessage(message, {});
						})
						.catch(e => {
							this._throwError(message, e);
							vscode.window.showErrorMessage(formatError(e));
						});
				}
			});
	}

	protected async close(message: IRequestMessage<string>) {
		let comment: IComment | undefined;
		if (message.args) {
			comment = await this._item.createIssueComment(message.args);
		}
		const closeUpdate = await this._item.close();
		const result: CloseResult = {
			state: closeUpdate.item.state.toUpperCase() as GithubItemStateEnum,
			commentEvent: comment ? {
				...comment,
				event: EventType.Commented
			} : undefined,
			closeEvent: closeUpdate.closedEvent
		};
		this._replyMessage(message, result);
	}

	protected set _currentPanel(panel: IssueOverviewPanel | undefined) {
		IssueOverviewPanel.currentPanel = panel;
	}

	public override dispose() {
		super.dispose();
		this._currentPanel = undefined;
		this._webview = undefined;
	}

	protected getHtmlForWebview() {
		const nonce = getNonce();

		const uri = vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview-pr-description.js');

		return `<!DOCTYPE html>
<html lang="en">
	<head>
		<meta charset="UTF-8">
		<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src vscode-resource: https:; media-src https:; script-src 'nonce-${nonce}'; style-src vscode-resource: 'unsafe-inline' http: https: data:;">

		<meta name="viewport" content="width=device-width, initial-scale=1.0">
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

	public getCurrentItem(): TItem | undefined {
		return this._item;
	}
}
