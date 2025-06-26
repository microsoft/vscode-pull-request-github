/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IComment } from '../common/comment';
import Logger from '../common/logger';
import { Remote } from '../common/remote';
import { ClosedEvent, EventType } from '../common/timelineEvent';
import { formatError } from '../common/utils';
import { GitHubRepository } from './githubRepository';
import {
	AddIssueCommentResponse,
	AddPullRequestToProjectResponse,
	EditIssueCommentResponse,
	LatestCommit,
	LatestReviewThread,
	LatestUpdatesResponse,
	UpdateIssueResponse,
} from './graphql';
import { GithubItemStateEnum, IAccount, IIssueEditData, IMilestone, IProject, IProjectItem, Issue } from './interface';
import { convertRESTIssueToRawPullRequest, parseGraphQlIssueComment } from './utils';

export class IssueModel<TItem extends Issue = Issue> {
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
	public readonly remote: Remote;
	public item: TItem;
	public bodyHTML?: string;

	private _onDidInvalidate = new vscode.EventEmitter<void>();
	public onDidInvalidate = this._onDidInvalidate.event;

	constructor(githubRepository: GitHubRepository, remote: Remote, item: TItem, skipUpdate: boolean = false) {
		this.githubRepository = githubRepository;
		this.remote = remote;
		this.item = item;

		if (!skipUpdate) {
			this.update(item);
		}
	}

	public invalidate() {
		// Something about the PR data is stale
		this._onDidInvalidate.fire();
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

	public get body(): string {
		if (this.item) {
			return this.item.body;
		}
		return '';
	}

	protected updateState(state: string) {
		if (state.toLowerCase() === 'open') {
			this.state = GithubItemStateEnum.Open;
		} else {
			this.state = GithubItemStateEnum.Closed;
		}
	}

	update(issue: TItem): void {
		this.id = issue.id;
		this.graphNodeId = issue.graphNodeId;
		this.number = issue.number;
		this.title = issue.title;
		if (issue.titleHTML) {
			this.titleHTML = issue.titleHTML;
		}
		if (!this.bodyHTML || (issue.body !== this.body)) {
			this.bodyHTML = issue.bodyHTML;
		}
		this.html_url = issue.url;
		this.author = issue.user;
		this.milestone = issue.milestone;
		this.createdAt = issue.createdAt;
		this.updatedAt = issue.updatedAt;

		this.updateState(issue.state);

		if (issue.assignees) {
			this.assignees = issue.assignees;
		}

		this.item = issue;
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
				this.item.body = data.updateIssue.issue.body;
				this.bodyHTML = data.updateIssue.issue.bodyHTML;
				this.title = data.updateIssue.issue.title;
				this.titleHTML = data.updateIssue.issue.titleHTML;
				this.invalidate();
			}
			return data!.updateIssue.issue;
		} catch (e) {
			throw new Error(formatError(e));
		}
	}

	canEdit(): Promise<boolean> {
		const username = this.author && this.author.login;
		return this.githubRepository.isCurrentUser(username);
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
		} catch (e) {
			throw new Error(formatError(e));
		}
	}

	async setLabels(labels: string[]): Promise<void> {
		const { octokit, remote } = await this.githubRepository.ensure();
		try {
			await octokit.call(octokit.api.issues.setLabels, {
				owner: remote.owner,
				repo: remote.repositoryName,
				issue_number: this.number,
				labels,
			});
		} catch (e) {
			// We don't get a nice error message from the API when setting labels fails.
			// Since adding labels isn't a critical part of the PR creation path it's safe to catch all errors that come from setting labels.
			Logger.error(`Failed to add labels to PR #${this.number}`, IssueModel.ID);
			vscode.window.showWarningMessage(vscode.l10n.t('Some, or all, labels could not be added to the pull request.'));
		}
	}

	async removeLabel(label: string): Promise<void> {
		const { octokit, remote } = await this.githubRepository.ensure();
		await octokit.call(octokit.api.issues.removeLabel, {
			owner: remote.owner,
			repo: remote.repositoryName,
			issue_number: this.number,
			name: label,
		});
	}

	public async removeProjects(projectItems: IProjectItem[]): Promise<void> {
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
		} catch (err) {
			Logger.error(err, IssueModel.ID);
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

	async updateMilestone(id: string): Promise<void> {
		const { mutate, schema } = await this.githubRepository.ensure();
		const finalId = id === 'null' ? null : id;

		try {
			await mutate<UpdateIssueResponse>({
				mutation: this.updateIssueSchema(schema),
				variables: {
					input: {
						...this.updateIssueInput(this.graphNodeId),
						milestoneId: finalId,
					},
				},
			});
		} catch (err) {
			Logger.error(err, IssueModel.ID);
		}
	}

	async replaceAssignees(allAssignees: IAccount[]): Promise<void> {
		Logger.debug(`Replace assignees of issue #${this.number} - enter`, IssueModel.ID);
		const { mutate, schema } = await this.githubRepository.ensure();

		try {
			if (schema.ReplaceActorsForAssignable) {
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
		} catch (e) {
			Logger.error(e, IssueModel.ID);
		}
		Logger.debug(`Replace assignees of issue #${this.number} - done`, IssueModel.ID);
	}

	async addAssignees(assigneesToAdd: string[]): Promise<void> {
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
