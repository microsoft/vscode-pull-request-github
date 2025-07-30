/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { COPILOT_ACCOUNTS, IComment } from '../common/comment';
import { Disposable } from '../common/lifecycle';
import Logger from '../common/logger';
import { Remote } from '../common/remote';
import { ITelemetry } from '../common/telemetry';
import { ClosedEvent, CrossReferencedEvent, EventType, TimelineEvent } from '../common/timelineEvent';
import { compareIgnoreCase, formatError } from '../common/utils';
import { OctokitCommon } from './common';
import { CopilotWorkingStatus, GitHubRepository } from './githubRepository';
import {
	AddIssueCommentResponse,
	AddPullRequestToProjectResponse,
	EditIssueCommentResponse,
	LatestCommit,
	LatestReviewThread,
	LatestUpdatesResponse,
	TimelineEventsResponse,
	UpdateIssueResponse,
} from './graphql';
import { GithubItemStateEnum, IAccount, IIssueEditData, IMilestone, IProject, IProjectItem, Issue } from './interface';
import { convertRESTIssueToRawPullRequest, eventTime, parseCombinedTimelineEvents, parseGraphQlIssueComment, parseMilestone, parseSelectRestTimelineEvents, restPaginate } from './utils';

export interface IssueChangeEvent {
	title?: true;
	body?: true;
	milestone?: true;
	// updatedAt?: true;
	state?: true;
	labels?: true;
	assignees?: true;
	projects?: true;
	comments?: true;

	timeline?: true;

	draft?: true;
	reviewers?: true;
}

export class IssueModel<TItem extends Issue = Issue> extends Disposable {
	static ID = 'IssueModel';
	public id: number;
	public graphNodeId: string;
	public number: number;
	public title: string;
	public titleHTML: string;
	public html_url: string;
	public state: GithubItemStateEnum = GithubItemStateEnum.Open;
	public author: IAccount;
	public assignees?: IAccount[];
	public createdAt: string;
	public updatedAt: string;
	public milestone?: IMilestone;
	public readonly githubRepository: GitHubRepository;
	protected readonly _telemetry: ITelemetry;
	public readonly remote: Remote;
	public item: TItem;
	public body: string;
	public bodyHTML?: string;

	private _timelineEvents: readonly TimelineEvent[] | undefined;

	protected _onDidChange = this._register(new vscode.EventEmitter<IssueChangeEvent>());
	public onDidChange = this._onDidChange.event;

	constructor(telemetry: ITelemetry, githubRepository: GitHubRepository, remote: Remote, item: TItem, skipUpdate: boolean = false) {
		super();
		this._telemetry = telemetry;
		this.githubRepository = githubRepository;
		this.remote = remote;
		this.item = item;

		if (!skipUpdate) {
			this.update(item);
		}
	}

	get timelineEvents(): readonly TimelineEvent[] {
		return this._timelineEvents ?? [];
	}

	protected set timelineEvents(timelineEvents: readonly TimelineEvent[]) {
		if (!this._timelineEvents || this._timelineEvents.length !== timelineEvents.length) {
			this._timelineEvents = timelineEvents;
			this._onDidChange.fire({ timeline: true });
		}
	}

	public get isOpen(): boolean {
		return this.state === GithubItemStateEnum.Open;
	}

	public get isClosed(): boolean {
		return this.state === GithubItemStateEnum.Closed;
	}

	public get isMerged(): boolean {
		return this.state === GithubItemStateEnum.Merged;
	}

	public get userAvatar(): string | undefined {
		if (this.item) {
			return this.item.user.avatarUrl;
		}

		return undefined;
	}

	public get userAvatarUri(): vscode.Uri | undefined {
		if (this.item) {
			const key = this.userAvatar;
			if (key) {
				const uri = vscode.Uri.parse(`${key}&s=${64}`);

				// hack, to ensure queries are not wrongly encoded.
				const originalToStringFn = uri.toString;
				uri.toString = function (_skipEncoding?: boolean | undefined) {
					return originalToStringFn.call(uri, true);
				};

				return uri;
			}
		}

		return undefined;
	}

	protected stateToStateEnum(state: string): GithubItemStateEnum {
		let newState = GithubItemStateEnum.Closed;
		if (state.toLowerCase() === 'open') {
			newState = GithubItemStateEnum.Open;
		}
		return newState;
	}

	protected doUpdate(issue: TItem): IssueChangeEvent {
		const changes: IssueChangeEvent = {};

		this.id = issue.id;
		this.graphNodeId = issue.graphNodeId;
		this.number = issue.number;
		this.html_url = issue.url;
		this.author = issue.user;
		this.createdAt = issue.createdAt;

		if (this.title !== issue.title) {
			changes.title = true;
			this.title = issue.title;
		}
		if (issue.titleHTML && this.titleHTML !== issue.titleHTML) {
			this.titleHTML = issue.titleHTML;
		}
		if (this.body !== issue.body) {
			changes.body = true;
			this.body = issue.body;
		}
		if ((!this.bodyHTML || (issue.body !== this.body)) && this.bodyHTML !== issue.bodyHTML) {
			this.bodyHTML = issue.bodyHTML;
		}
		if (this.milestone?.id !== issue.milestone?.id) {
			changes.milestone = true;
			this.milestone = issue.milestone;
		}
		if (this.updatedAt !== issue.updatedAt) {
			this.updatedAt = issue.updatedAt;
		}
		const newState = this.stateToStateEnum(issue.state);
		if (this.state !== newState) {
			changes.state = true;
			this.state = newState;
		}
		if (issue.assignees && (issue.assignees.length !== (this.assignees?.length ?? 0) || issue.assignees.some(assignee => this.assignees?.every(a => a.id !== assignee.id)))) {
			changes.assignees = true;
			this.assignees = issue.assignees;
		}
		return changes;
	}

	update(issue: TItem): void {
		const changes = this.doUpdate(issue);
		this.item = issue;
		if (Object.keys(changes).length > 0) {
			this._onDidChange.fire(changes);
		}
	}

	equals(other: IssueModel<TItem> | undefined): boolean {
		if (!other) {
			return false;
		}

		if (this.number !== other.number) {
			return false;
		}

		if (this.html_url !== other.html_url) {
			return false;
		}

		return true;
	}

	protected updateIssueInput(id: string): Object {
		return {
			id
		};
	}

	protected updateIssueSchema(schema: any): any {
		return schema.UpdateIssue;
	}

	async edit(toEdit: IIssueEditData): Promise<{ body: string; bodyHTML: string; title: string; titleHTML: string }> {
		try {
			const { mutate, schema } = await this.githubRepository.ensure();

			const { data } = await mutate<UpdateIssueResponse>({
				mutation: this.updateIssueSchema(schema),
				variables: {
					input: {
						...this.updateIssueInput(this.graphNodeId),
						body: toEdit.body,
						title: toEdit.title,
					},
				},
			});
			if (data?.updateIssue.issue) {
				const changes: IssueChangeEvent = {};
				if (this.body !== data.updateIssue.issue.body) {
					changes.body = true;
					this.item.body = data.updateIssue.issue.body;
					this.bodyHTML = data.updateIssue.issue.bodyHTML;
				}
				if (this.title !== data.updateIssue.issue.title) {
					changes.title = true;
					this.title = data.updateIssue.issue.title;
					this.titleHTML = data.updateIssue.issue.titleHTML;
				}
				this._onDidChange.fire(changes);
			}
			return data!.updateIssue.issue;
		} catch (e) {
			throw new Error(formatError(e));
		}
	}

	canEdit(): Promise<boolean> {
		const username = this.author && this.author.login;
		return this.githubRepository.isCurrentUser(this.remote.authProviderId, username);
	}

	async createIssueComment(text: string): Promise<IComment> {
		const { mutate, schema } = await this.githubRepository.ensure();
		const { data } = await mutate<AddIssueCommentResponse>({
			mutation: schema.AddIssueComment,
			variables: {
				input: {
					subjectId: this.graphNodeId,
					body: text,
				},
			},
		});

		this._onDidChange.fire({ timeline: true });
		return parseGraphQlIssueComment(data!.addComment.commentEdge.node, this.githubRepository);
	}

	async editIssueComment(comment: IComment, text: string): Promise<IComment> {
		try {
			const { mutate, schema } = await this.githubRepository.ensure();

			const { data } = await mutate<EditIssueCommentResponse>({
				mutation: schema.EditIssueComment,
				variables: {
					input: {
						id: comment.graphNodeId,
						body: text,
					},
				},
			});

			this._onDidChange.fire({ timeline: true });
			return parseGraphQlIssueComment(data!.updateIssueComment.issueComment, this.githubRepository);
		} catch (e) {
			throw new Error(formatError(e));
		}
	}

	async deleteIssueComment(commentId: string): Promise<void> {
		try {
			const { octokit, remote } = await this.githubRepository.ensure();

			await octokit.call(octokit.api.issues.deleteComment, {
				owner: remote.owner,
				repo: remote.repositoryName,
				comment_id: Number(commentId),
			});
			this._onDidChange.fire({ timeline: true });
		} catch (e) {
			throw new Error(formatError(e));
		}
	}

	async setLabels(labels: string[]): Promise<void> {
		const { octokit, remote } = await this.githubRepository.ensure();
		try {
			const result = await octokit.call(octokit.api.issues.setLabels, {
				owner: remote.owner,
				repo: remote.repositoryName,
				issue_number: this.number,
				labels,
			});
			this.item.labels = result.data.map(label => ({
				name: label.name,
				color: label.color,
				description: label.description ?? undefined
			}));
			this._onDidChange.fire({ labels: true });
		} catch (e) {
			// We don't get a nice error message from the API when setting labels fails.
			// Since adding labels isn't a critical part of the PR creation path it's safe to catch all errors that come from setting labels.
			Logger.error(`Failed to add labels to PR #${this.number}`, IssueModel.ID);
			vscode.window.showWarningMessage(vscode.l10n.t('Some, or all, labels could not be added to the pull request.'));
		}
	}

	async removeLabel(label: string): Promise<void> {
		const { octokit, remote } = await this.githubRepository.ensure();
		const result = await octokit.call(octokit.api.issues.removeLabel, {
			owner: remote.owner,
			repo: remote.repositoryName,
			issue_number: this.number,
			name: label,
		});
		this.item.labels = result.data.map(label => ({
			name: label.name,
			color: label.color,
			description: label.description ?? undefined
		}));
		this._onDidChange.fire({ labels: true });
	}

	public async removeProjects(projectItems: IProjectItem[]): Promise<void> {
		const result = await this.doRemoveProjects(projectItems);
		if (!result) {
			// If we failed to remove the projects, we don't want to update the model.
			return;
		}
		this._onDidChange.fire({ projects: true });
	}

	private async doRemoveProjects(projectItems: IProjectItem[]): Promise<boolean> {
		const { mutate, schema } = await this.githubRepository.ensure();

		try {
			await Promise.all(projectItems.map(project =>
				mutate<void>({
					mutation: schema.RemovePullRequestFromProject,
					variables: {
						input: {
							itemId: project.id,
							projectId: project.project.id
						},
					},
				})));
			this.item.projectItems = this.item.projectItems?.filter(project => !projectItems.find(p => p.project.id === project.project.id));
			return true;
		} catch (err) {
			Logger.error(err, IssueModel.ID);
			return false;
		}
	}

	private async addProjects(projects: IProject[]): Promise<void> {
		const { mutate, schema } = await this.githubRepository.ensure();

		try {
			const itemIds = await Promise.all(projects.map(project =>
				mutate<AddPullRequestToProjectResponse>({
					mutation: schema.AddPullRequestToProject,
					variables: {
						input: {
							contentId: this.item.graphNodeId,
							projectId: project.id
						},
					},
				})));
			if (!this.item.projectItems) {
				this.item.projectItems = [];
			}
			this.item.projectItems.push(...projects.map((project, index) => { return { project, id: itemIds[index].data!.addProjectV2ItemById.item.id }; }));
		} catch (err) {
			Logger.error(err, IssueModel.ID);
		}
	}

	async updateProjects(projects: IProject[]): Promise<IProjectItem[] | undefined> {
		const projectsToAdd: IProject[] = projects.filter(project => !this.item.projectItems?.find(p => p.project.id === project.id));
		const projectsToRemove: IProjectItem[] = this.item.projectItems?.filter(project => !projects.find(p => p.id === project.project.id)) ?? [];
		await this.removeProjects(projectsToRemove);
		await this.addProjects(projectsToAdd);
		this._onDidChange.fire({ projects: true });
		return this.item.projectItems;
	}

	protected getUpdatesQuery(schema: any): any {
		return schema.LatestIssueUpdates;
	}

	async getLastUpdateTime(time: Date): Promise<Date> {
		Logger.debug(`Fetch timeline events of issue #${this.number} - enter`, IssueModel.ID);
		const githubRepository = this.githubRepository;
		const { query, remote, schema } = await githubRepository.ensure();
		try {
			const { data } = await query<LatestUpdatesResponse>({
				query: this.getUpdatesQuery(schema),
				variables: {
					owner: remote.owner,
					name: remote.repositoryName,
					number: this.number,
					since: new Date(time),
				}
			});

			const times = [
				time,
				new Date(data.repository.pullRequest.updatedAt),
				...(data.repository.pullRequest.reactions.nodes.map(node => new Date(node.createdAt))),
				...(data.repository.pullRequest.comments.nodes.map(node => new Date(node.updatedAt))),
				...(data.repository.pullRequest.comments.nodes.flatMap(node => node.reactions.nodes.map(reaction => new Date(reaction.createdAt)))),
				...(data.repository.pullRequest.timelineItems.nodes.map(node => {
					const latestCommit = node as Partial<LatestCommit>;
					if (latestCommit.commit?.committedDate) {
						return new Date(latestCommit.commit.committedDate);
					}
					const latestReviewThread = node as Partial<LatestReviewThread>;
					if ((latestReviewThread.comments?.nodes.length ?? 0) > 0) {
						return new Date(latestReviewThread.comments!.nodes[0].createdAt);
					}
					return new Date((node as { createdAt: string }).createdAt);
				}))
			];

			// Sort times and return the most recent one
			return new Date(Math.max(...times.map(t => t.getTime())));
		} catch (e) {
			Logger.error(`Error fetching timeline events of issue #${this.number} - ${formatError(e)}`, IssueModel.ID);
			return time; // Return the original time in case of an error
		}
	}

	async getIssueTimelineEvents(issueModel: IssueModel): Promise<TimelineEvent[]> {
		Logger.debug(`Fetch timeline events of issue #${issueModel.number} - enter`, GitHubRepository.ID);
		const { query, remote, schema } = await this.githubRepository.ensure();

		try {
			const { data } = await query<TimelineEventsResponse>({
				query: schema.IssueTimelineEvents,
				variables: {
					owner: remote.owner,
					name: remote.repositoryName,
					number: issueModel.number,
				},
			});

			if (data.repository === null) {
				Logger.error('Unexpected null repository when getting issue timeline events', GitHubRepository.ID);
				return [];
			}

			const ret = data.repository.pullRequest.timelineItems.nodes;
			const events = await parseCombinedTimelineEvents(ret, await this.getCopilotTimelineEvents(issueModel, true), this.githubRepository);

			const crossRefs = events.filter((event): event is CrossReferencedEvent => {
				if ((event.event === EventType.CrossReferenced) && !event.source.isIssue) {
					return !this.githubRepository.getExistingPullRequestModel(event.source.number) && (compareIgnoreCase(event.source.owner, issueModel.remote.owner) === 0 && compareIgnoreCase(event.source.repo, issueModel.remote.repositoryName) === 0);
				}
				return false;

			});

			for (const unseenPrs of crossRefs) {
				// Kick off getting the new PRs so that the system knows about them (and refreshes the tree when they're found)
				this.githubRepository.getPullRequest(unseenPrs.source.number);
			}

			issueModel.timelineEvents = events;
			return events;
		} catch (e) {
			console.log(e);
			return [];
		}
	}

	/**
	 * TODO: @alexr00 we should delete this https://github.com/microsoft/vscode-pull-request-github/issues/6965
	 */
	async getCopilotTimelineEvents(issueModel: IssueModel, skipMerge: boolean = false): Promise<TimelineEvent[]> {
		if (!COPILOT_ACCOUNTS[issueModel.author.login]) {
			return [];
		}

		Logger.debug(`Fetch Copilot timeline events of issue #${issueModel.number} - enter`, GitHubRepository.ID);

		const { octokit, remote } = await this.githubRepository.ensure();
		try {
			const timeline = await restPaginate<typeof octokit.api.issues.listEventsForTimeline, OctokitCommon.ListEventsForTimelineResponse>(octokit.api.issues.listEventsForTimeline, {
				issue_number: issueModel.number,
				owner: remote.owner,
				repo: remote.repositoryName,
				per_page: 100
			});

			const timelineEvents = parseSelectRestTimelineEvents(issueModel, timeline);
			if (timelineEvents.length === 0) {
				return [];
			}
			if (!skipMerge) {
				const oldLastEvent = issueModel.timelineEvents.length > 0 ? issueModel.timelineEvents[issueModel.timelineEvents.length - 1] : undefined;
				let allEvents: TimelineEvent[];
				if (!oldLastEvent) {
					allEvents = timelineEvents;
				} else {
					const oldEventTime = (eventTime(oldLastEvent) ?? 0);
					const newEvents = timelineEvents.filter(event => (eventTime(event) ?? 0) > oldEventTime);
					allEvents = [...issueModel.timelineEvents, ...newEvents];
				}
				issueModel.timelineEvents = allEvents;
			}
			return timelineEvents;
		} catch (e) {
			Logger.error(`Error fetching Copilot timeline events of issue #${issueModel.number} - ${formatError(e)}`, GitHubRepository.ID);
			return [];
		}
	}

	async copilotWorkingStatus(issueModel: IssueModel): Promise<CopilotWorkingStatus | undefined> {
		const copilotEvents = await this.getCopilotTimelineEvents(issueModel);
		if (copilotEvents.length > 0) {
			const lastEvent = copilotEvents[copilotEvents.length - 1];
			if (lastEvent.event === EventType.CopilotFinished) {
				return CopilotWorkingStatus.Done;
			} else if (lastEvent.event === EventType.CopilotStarted) {
				return CopilotWorkingStatus.InProgress;
			} else if (lastEvent.event === EventType.CopilotFinishedError) {
				return CopilotWorkingStatus.Error;
			}
		}
		return CopilotWorkingStatus.NotCopilotIssue;
	}

	async updateMilestone(id: string): Promise<void> {
		const { mutate, schema } = await this.githubRepository.ensure();
		const finalId = id === 'null' ? null : id;

		try {
			const result = await mutate<UpdateIssueResponse>({
				mutation: this.updateIssueSchema(schema),
				variables: {
					input: {
						...this.updateIssueInput(this.graphNodeId),
						milestoneId: finalId,
					},
				},
			});
			this.milestone = parseMilestone(result.data!.updateIssue.issue.milestone);
			this._onDidChange.fire({ milestone: true });
		} catch (err) {
			Logger.error(err, IssueModel.ID);
		}
	}

	async replaceAssignees(allAssignees: IAccount[]): Promise<void> {
		Logger.debug(`Replace assignees of issue #${this.number} - enter`, IssueModel.ID);
		const { mutate, schema } = await this.githubRepository.ensure();

		try {
			if (schema.ReplaceActorsForAssignable) {
				const assignToCopilot = allAssignees.find(assignee => COPILOT_ACCOUNTS[assignee.login]);
				const alreadyHasCopilot = this.assignees?.find(assignee => COPILOT_ACCOUNTS[assignee.login]) !== undefined;
				if (assignToCopilot && !alreadyHasCopilot) {
					/* __GDPR__
						"pr.assignCopilot" : {}
					*/
					this._telemetry.sendTelemetryEvent('pr.assignCopilot');
				}

				const assigneeIds = allAssignees.map(assignee => assignee.id);
				await mutate({
					mutation: schema.ReplaceActorsForAssignable,
					variables: {
						input: {
							actorIds: assigneeIds,
							assignableId: this.graphNodeId
						}
					}
				});
			} else {
				const addAssignees = allAssignees.map(assignee => assignee.login);
				const removeAssignees = (this.assignees?.filter(currentAssignee => !allAssignees.find(newAssignee => newAssignee.login === currentAssignee.login)) ?? []).map(assignee => assignee.login);
				await this.addAssignees(addAssignees);
				await this.deleteAssignees(removeAssignees);
			}
			this.assignees = allAssignees;
			this._onDidChange.fire({ assignees: true });
		} catch (e) {
			Logger.error(e, IssueModel.ID);
		}
		Logger.debug(`Replace assignees of issue #${this.number} - done`, IssueModel.ID);
	}

	private async addAssignees(assigneesToAdd: string[]): Promise<void> {
		const { octokit, remote } = await this.githubRepository.ensure();
		await octokit.call(octokit.api.issues.addAssignees, {
			owner: remote.owner,
			repo: remote.repositoryName,
			issue_number: this.number,
			assignees: assigneesToAdd,
		});
	}

	private async deleteAssignees(assignees: string[]): Promise<void> {
		const { octokit, remote } = await this.githubRepository.ensure();
		await octokit.call(octokit.api.issues.removeAssignees, {
			owner: remote.owner,
			repo: remote.repositoryName,
			issue_number: this.number,
			assignees,
		});
	}

	async close(): Promise<{ item: Issue, closedEvent: ClosedEvent }> {
		const { octokit, remote } = await this.githubRepository.ensure();
		const ret = await octokit.call(octokit.api.issues.update, {
			owner: remote.owner,
			repo: remote.repositoryName,
			issue_number: this.number,
			state: 'closed'
		});

		this.state = GithubItemStateEnum.Closed;
		this._onDidChange.fire({ state: true });
		return {
			item: convertRESTIssueToRawPullRequest(ret.data, this.githubRepository),
			closedEvent: {
				createdAt: ret.data.closed_at ?? '',
				event: EventType.Closed,
				id: `${ret.data.id}`,
				actor: {
					login: ret.data.closed_by!.login,
					avatarUrl: ret.data.closed_by!.avatar_url,
					url: ret.data.closed_by!.url
				}
			}
		};
	}
}
