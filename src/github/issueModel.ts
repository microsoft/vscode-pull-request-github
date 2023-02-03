/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IComment } from '../common/comment';
import Logger from '../common/logger';
import { Remote } from '../common/remote';
import { TimelineEvent } from '../common/timelineEvent';
import { formatError } from '../common/utils';
import { OctokitCommon } from './common';
import { GitHubRepository } from './githubRepository';
import {
	AddIssueCommentResponse,
	EditIssueCommentResponse,
	TimelineEventsResponse,
	UpdatePullRequestResponse,
} from './graphql';
import { GithubItemStateEnum, IAccount, IMilestone, IPullRequestEditData, Issue } from './interface';
import { parseGraphQlIssueComment, parseGraphQLTimelineEvents } from './utils';

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

	async edit(toEdit: IPullRequestEditData): Promise<{ body: string; bodyHTML: string; title: string; titleHTML: string }> {
		try {
			const { mutate, schema } = await this.githubRepository.ensure();

			const { data } = await mutate<UpdatePullRequestResponse>({
				mutation: schema.UpdatePullRequest,
				variables: {
					input: {
						pullRequestId: this.graphNodeId,
						body: toEdit.body,
						title: toEdit.title,
					},
				},
			});
			if (data?.updatePullRequest.pullRequest) {
				this.item.body = data.updatePullRequest.pullRequest.body;
				this.bodyHTML = data.updatePullRequest.pullRequest.bodyHTML;
				this.title = data.updatePullRequest.pullRequest.title;
				this.titleHTML = data.updatePullRequest.pullRequest.titleHTML;
				this.invalidate();
			}
			return data!.updatePullRequest.pullRequest;
		} catch (e) {
			throw new Error(formatError(e));
		}
	}

	canEdit(): Promise<boolean> {
		const username = this.author && this.author.login;
		return this.githubRepository.isCurrentUser(username);
	}

	async getIssueComments(): Promise<OctokitCommon.IssuesListCommentsResponseData> {
		Logger.debug(`Fetch issue comments of PR #${this.number} - enter`, IssueModel.ID);
		const { octokit, remote } = await this.githubRepository.ensure();

		const promise = await octokit.call(octokit.api.issues.listComments, {
			owner: remote.owner,
			repo: remote.repositoryName,
			issue_number: this.number,
			per_page: 100,
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
			Logger.appendLine(`Failed to add labels to PR #${this.number}`, IssueModel.ID);
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
					number: this.number,
				},
			});
			const ret = data.repository.pullRequest.timelineItems.nodes;
			const events = parseGraphQLTimelineEvents(ret, githubRepository);

			return events;
		} catch (e) {
			console.log(e);
			return [];
		}
	}


}
