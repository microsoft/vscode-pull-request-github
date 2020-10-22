/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as OctokitTypes from '@octokit/types';
import { IComment } from '../common/comment';
import { Remote } from '../common/remote';
import { GitHubRepository } from './githubRepository';
import { AddIssueCommentResponse, AddReactionResponse, DeleteReactionResponse, EditIssueCommentResponse, TimelineEventsResponse, UpdatePullRequestResponse } from './graphql';
import { IAccount, Issue, GithubItemStateEnum, IMilestone, IPullRequestEditData } from './interface';
import { getReactionGroup, parseGraphQlIssueComment, parseGraphQLTimelineEvents } from './utils';
import { formatError } from '../common/utils';
import Logger from '../common/logger';
import { TimelineEvent } from '../common/timelineEvent';

export class IssueModel {
	static ID = 'IssueModel';
	public id: number;
	public graphNodeId: string;
	public number: number;
	public title: string;
	public html_url: string;
	public state: GithubItemStateEnum = GithubItemStateEnum.Open;
	public author: IAccount;
	public assignees?: IAccount[];
	public createdAt: string;
	public updatedAt: string;
	public milestone?: IMilestone;
	public readonly githubRepository: GitHubRepository;
	public readonly remote: Remote;
	public item: Issue;
	public bodyHTML?: string;

	constructor(githubRepository: GitHubRepository, remote: Remote, item: Issue) {
		this.githubRepository = githubRepository;
		this.remote = remote;
		this.item = item;
		this.update(item);
	}

	public get isOpen(): boolean {
		return this.state === GithubItemStateEnum.Open;
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
				uri.toString = function (skipEncoding?: boolean | undefined) {
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

	update(issue: Issue): void {
		this.id = issue.id;
		this.graphNodeId = issue.graphNodeId;
		this.number = issue.number;
		this.title = issue.title;
		this.bodyHTML = issue.bodyHTML;
		this.html_url = issue.url;
		this.author = issue.user;
		this.milestone = issue.milestone;
		this.createdAt = issue.createdAt;
		this.updatedAt = issue.updatedAt;

		this.updateState(issue.state);

		if (issue.assignees) {
			this.assignees = issue.assignees;
		}
	}

	equals(other: IssueModel | undefined): boolean {
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

	async edit(toEdit: IPullRequestEditData): Promise<{ body: string, bodyHTML: string, title: string }> {
		try {
			const { mutate, schema } = await this.githubRepository.ensure();

			const { data } = await mutate<UpdatePullRequestResponse>({
				mutation: schema.UpdatePullRequest,
				variables: {
					input: {
						pullRequestId: this.graphNodeId,
						body: toEdit.body,
						title: toEdit.title
					}
				}
			});

			return data!.updatePullRequest.pullRequest;
		} catch (e) {
			throw new Error(formatError(e));
		}
	}

	canEdit(): boolean {
		const username = this.author && this.author.login;
		return this.githubRepository.isCurrentUser(username);
	}

	async getIssueComments(): Promise<OctokitTypes.IssuesListCommentsResponseData> {
		Logger.debug(`Fetch issue comments of PR #${this.number} - enter`, IssueModel.ID);
		const { octokit, remote } = await this.githubRepository.ensure();

		const promise = await octokit.issues.listComments({
			owner: remote.owner,
			repo: remote.repositoryName,
			issue_number: this.number,
			per_page: 100
		});
		Logger.debug(`Fetch issue comments of PR #${this.number} - done`, IssueModel.ID);

		return promise.data;
	}

	async createIssueComment(text: string): Promise<IComment> {
		const { mutate, schema } = await this.githubRepository.ensure();
		const { data } = await mutate<AddIssueCommentResponse>({
			mutation: schema.AddIssueComment,
			variables: {
				input: {
					subjectId: this.graphNodeId,
					body: text
				}
			}
		});

		return parseGraphQlIssueComment(data!.addComment.commentEdge.node);
	}

	async editIssueComment(comment: IComment, text: string): Promise<IComment> {
		try {
			const { mutate, schema } = await this.githubRepository.ensure();

			const { data } = await mutate<EditIssueCommentResponse>({
				mutation: schema.EditIssueComment,
				variables: {
					input: {
						id: comment.graphNodeId,
						body: text
					}
				}
			});

			return parseGraphQlIssueComment(data!.updateIssueComment.issueComment);
		} catch (e) {
			throw new Error(formatError(e));
		}
	}

	async deleteIssueComment(commentId: string): Promise<void> {
		try {
			const { octokit, remote } = await this.githubRepository.ensure();

			await octokit.issues.deleteComment({
				owner: remote.owner,
				repo: remote.repositoryName,
				comment_id: Number(commentId)
			});
		} catch (e) {
			throw new Error(formatError(e));
		}
	}

	async addLabels(labels: string[]): Promise<void> {
		const { octokit, remote } = await this.githubRepository.ensure();
		await octokit.issues.addLabels({
			owner: remote.owner,
			repo: remote.repositoryName,
			issue_number: this.number,
			labels
		});
	}

	async removeLabel(label: string): Promise<void> {
		const { octokit, remote } = await this.githubRepository.ensure();
		await octokit.issues.removeLabel({
			owner: remote.owner,
			repo: remote.repositoryName,
			issue_number: this.number,
			name: label
		});
	}

	async getIssueTimelineEvents(): Promise<TimelineEvent[]> {
		Logger.debug(`Fetch timeline events of issue #${this.number} - enter`, IssueModel.ID);
		const githubRepository = this.githubRepository;
		const { query, remote, schema } = await githubRepository.ensure();

		try {
			const { data } = await query<TimelineEventsResponse>({
				query: schema.IssueTimelineEvents,
				variables: {
					owner: remote.owner,
					name: remote.repositoryName,
					number: this.number
				}
			});
			const ret = data.repository.pullRequest.timelineItems.nodes;
			const events = parseGraphQLTimelineEvents(ret, githubRepository);

			return events;
		} catch (e) {
			console.log(e);
			return [];
		}
	}

	async addCommentReaction(graphNodeId: string, reaction: vscode.CommentReaction): Promise<AddReactionResponse> {
		const reactionEmojiToContent = getReactionGroup().reduce((prev, curr) => {
			prev[curr.label] = curr.title;
			return prev;
		}, {} as { [key: string]: string });
		const { mutate, schema } = await this.githubRepository.ensure();
		const { data } = await mutate<AddReactionResponse>({
			mutation: schema.AddReaction,
			variables: {
				input: {
					subjectId: graphNodeId,
					content: reactionEmojiToContent[reaction.label!]
				}
			}
		});

		return data!;
	}

	async deleteCommentReaction(graphNodeId: string, reaction: vscode.CommentReaction): Promise<DeleteReactionResponse> {
		const reactionEmojiToContent = getReactionGroup().reduce((prev, curr) => {
			prev[curr.label] = curr.title;
			return prev;
		}, {} as { [key: string]: string });
		const { mutate, schema } = await this.githubRepository.ensure();
		const { data } = await mutate<DeleteReactionResponse>({
			mutation: schema.DeleteReaction,
			variables: {
				input: {
					subjectId: graphNodeId,
					content: reactionEmojiToContent[reaction.label!]
				}
			}
		});

		return data!;
	}
}
