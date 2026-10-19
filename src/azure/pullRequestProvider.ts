/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AzureClient, PullRequest as AzurePullRequest, Identity, PolicyEvaluation, PullRequestStatus, ReviewThread, ThreadComment } from './client';
import { azureRepositoryUrl } from './remote';
import { PendingReviews } from './review';
import { DiffSide, IComment, IReviewThread, SubjectType } from '../common/comment';
import { EventType, ReviewEvent, ReviewStateValue } from '../common/timelineEvent';
import { AccountType, CheckState, GithubItemStateEnum, IAccount, IIssueEditData, MergeMethod, PullRequest, PullRequestChecks, PullRequestMergeability, ReviewEventEnum } from '../github/interface';
import { ProviderCommentReference, ProviderSnapshot, PullRequestProvider } from '../providers/pullRequestProvider';

function positiveId(value: string): number {
	if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
		throw new Error('Azure DevOps returned an invalid thread or comment identifier.');
	}
	return Number(value);
}

function reviewState(vote: number | undefined): ReviewStateValue {
	switch (vote) {
		case 10:
		case 5:
			return 'APPROVED';
		case -10:
			return 'CHANGES_REQUESTED';
		default:
			return 'REQUESTED';
	}
}

function mergeability(status: string | undefined): PullRequestMergeability {
	switch (status) {
		case 'succeeded':
			return PullRequestMergeability.Mergeable;
		case 'conflicts':
			return PullRequestMergeability.Conflict;
		case 'failure':
		case 'rejectedByPolicy':
			return PullRequestMergeability.NotMergeable;
		default:
			return PullRequestMergeability.Unknown;
	}
}

function checkState(state: string): CheckState {
	switch (state.toLowerCase()) {
		case 'approved':
		case 'succeeded':
			return CheckState.Success;
		case 'rejected':
		case 'failed':
		case 'error':
		case 'broken':
			return CheckState.Failure;
		case 'queued':
		case 'running':
		case 'pending':
		case 'notset':
			return CheckState.Pending;
		case 'notapplicable':
			return CheckState.Neutral;
		default:
			return CheckState.Unknown;
	}
}

export class AzurePullRequestProvider implements PullRequestProvider {
	readonly id = 'azureDevOps';
	readonly capabilities = Object.freeze({
		attachments: false, projects: false, milestones: false, assignees: false,
		mergeQueue: false, stacks: false, autoMerge: false,
	});

	constructor(private readonly client: AzureClient, private readonly reviews: PendingReviews) { }

	private account(identity: Identity): IAccount {
		return {
			id: identity.id,
			login: identity.id,
			name: identity.displayName,
			email: identity.uniqueName,
			avatarUrl: identity.imageUrl,
			url: azureRepositoryUrl(this.client.remote),
			accountType: AccountType.User,
		};
	}

	private model(pr: AzurePullRequest): PullRequest {
		const repository = {
			cloneUrl: azureRepositoryUrl(this.client.remote),
			isInOrganization: true,
			owner: this.client.remote.project,
			name: this.client.remote.repository,
		};
		const ref = (name: string, sha: string) => ({
			label: name.replace(/^refs\/heads\//, ''),
			ref: name.replace(/^refs\/heads\//, ''),
			sha,
			repo: repository,
		});
		const headRepository = pr.forkSource?.repository;
		const head = ref(pr.sourceRefName, pr.lastMergeSourceCommit.commitId);
		if (headRepository) {
			head.repo = {
				...repository,
				cloneUrl: azureRepositoryUrl({ ...this.client.remote, project: headRepository.project.name, repository: headRepository.name }),
				owner: headRepository.project.name,
				name: headRepository.name,
			};
		}
		return {
			id: pr.pullRequestId,
			graphNodeId: `${this.client.remote.organizationUrl}/${pr.repository.id}/${pr.pullRequestId}`,
			number: pr.pullRequestId,
			url: this.client.pullRequestUrl(pr.pullRequestId),
			title: pr.title,
			titleHTML: '',
			body: pr.description ?? '',
			state: pr.status === 'active' ? 'open' : 'closed',
			isDraft: pr.isDraft,
			merged: pr.status === 'completed',
			createdAt: pr.creationDate ?? '',
			updatedAt: pr.creationDate ?? '',
			user: this.account(pr.createdBy),
			head,
			base: ref(pr.targetRefName, pr.lastMergeTargetCommit.commitId),
			commits: [],
			labels: [],
			assignees: [],
			commentCount: 0,
			reactionCount: 0,
			reactions: [],
			viewerCanUpdate: false,
			mergeable: mergeability(pr.mergeStatus),
			autoMerge: !!pr.autoCompleteSetBy,
		};
	}

	private comment(number: number, thread: ReviewThread, comment: ThreadComment, viewer: Identity): IComment {
		const url = `${this.client.pullRequestUrl(number)}?discussionId=${thread.id}`;
		return {
			id: comment.id,
			graphNodeId: `${thread.id}:${comment.id}`,
			threadId: String(thread.id),
			pullRequestReviewId: thread.id,
			body: comment.content ?? '',
			user: this.account(comment.author),
			createdAt: comment.publishedDate ?? '',
			url,
			htmlUrl: url,
			diffHunk: '',
			path: thread.threadContext?.filePath.replace(/^\//, ''),
			canEdit: viewer.id === comment.author.id,
			canDelete: viewer.id === comment.author.id,
		};
	}

	private thread(number: number, thread: ReviewThread, viewer: Identity): IReviewThread {
		const context = thread.threadContext;
		const left = !context?.rightFileStart && !!context?.leftFileStart;
		const start = left ? context?.leftFileStart?.line : context?.rightFileStart?.line;
		const end = left ? context?.leftFileEnd?.line : context?.rightFileEnd?.line;
		const resolved = thread.status === 2 || thread.status === 'fixed';
		return {
			id: String(thread.id),
			prReviewDatabaseId: thread.id,
			path: context?.filePath.replace(/^\//, '') ?? '',
			diffSide: left ? DiffSide.LEFT : DiffSide.RIGHT,
			startLine: start ?? 0,
			endLine: end ?? start ?? 0,
			originalStartLine: start ?? 0,
			originalEndLine: end ?? start ?? 0,
			isResolved: resolved,
			viewerCanResolve: !resolved,
			viewerCanUnresolve: resolved,
			isOutdated: false,
			subjectType: start === undefined ? SubjectType.FILE : SubjectType.LINE,
			comments: thread.comments.filter(comment => !comment.isDeleted && comment.commentType !== 'system' && comment.commentType !== 3)
				.map(comment => this.comment(number, thread, comment, viewer)),
		};
	}

	private checks(policies: PolicyEvaluation[], statuses: PullRequestStatus[]): PullRequestChecks {
		const checks: PullRequestChecks['statuses'] = [
			...policies.map(policy => ({
				id: policy.evaluationId,
				databaseId: undefined,
				url: undefined,
				avatarUrl: undefined,
				state: checkState(policy.status),
				description: policy.configuration.type.displayName,
				targetUrl: null,
				context: policy.configuration.type.displayName,
				workflowName: undefined,
				event: undefined,
				isRequired: policy.configuration.isBlocking,
				isCheckRun: false,
			})),
			...statuses.map(status => ({
				id: String(status.id),
				databaseId: status.id,
				url: status.targetUrl,
				avatarUrl: undefined,
				state: checkState(status.state),
				description: status.description ?? null,
				targetUrl: status.targetUrl ?? null,
				context: status.context.name,
				workflowName: status.context.genre,
				event: undefined,
				isRequired: false,
				isCheckRun: false,
			})),
		];
		const states = checks.map(check => check.state);
		const state = states.includes(CheckState.Failure) ? CheckState.Failure
			: states.includes(CheckState.Pending) ? CheckState.Pending
				: states.includes(CheckState.Unknown) || !states.length ? CheckState.Unknown : CheckState.Success;
		return { state, statuses: checks };
	}

	async list(): Promise<PullRequest[]> {
		return (await this.client.pullRequests()).map(pr => this.model(pr));
	}

	async load(number: number): Promise<ProviderSnapshot> {
		const [pr, viewer, threads, labels, workItems, statuses, commits] = await Promise.all([
			this.client.pullRequest(number), this.client.currentUser(), this.client.threads(number),
			this.client.labels(number), this.client.linkedWorkItems(number), this.client.statuses(number), this.client.commits(number),
		]);
		const policies = await this.client.policies(pr);
		const model = this.model(pr);
		const mappedThreads = threads.filter(thread => !thread.isDeleted).map(thread => this.thread(number, thread, viewer));
		model.labels = labels.map(label => ({ name: label.name, color: '' }));
		model.closingIssues = workItems.map(item => ({
			id: item.id, number: item.id, title: item.fields['System.Title'],
			state: item.fields['System.State'].toLowerCase() === 'closed' ? GithubItemStateEnum.Closed : GithubItemStateEnum.Open,
			url: this.client.workItemUrl(item.id),
		}));
		model.commits = commits.map(commit => ({ message: commit.comment ?? '' }));
		model.commentCount = mappedThreads.reduce((sum, thread) => sum + thread.comments.length, 0);
		const events: ReviewEvent[] = mappedThreads.filter(thread => thread.comments.length > 0).map(thread => {
			const first = thread.comments[0];
			if (!first.user) {
				throw new Error('Azure DevOps did not return the discussion author.');
			}
			return {
				id: Number(thread.id),
				event: EventType.Reviewed,
				comments: thread.comments,
				submittedAt: first.createdAt,
				body: '',
				htmlUrl: this.client.pullRequestUrl(number),
				user: first.user,
				authorAssociation: '',
				state: 'COMMENTED',
				reviewThreads: {
					[thread.id]: { threadId: thread.id, isResolved: thread.isResolved, canResolve: thread.viewerCanResolve, canUnresolve: thread.viewerCanUnresolve },
				},
			};
		});
		return {
			pullRequest: model,
			currentUser: this.account(viewer),
			reviewers: pr.reviewers.map(reviewer => ({ reviewer: this.account(reviewer), state: reviewState(reviewer.vote) })),
			threads: mappedThreads,
			events,
			checks: this.checks(policies, statuses),
		};
	}

	async create(title: string, body: string, source: string, target: string, draft: boolean): Promise<PullRequest> {
		const ref = (name: string) => name.startsWith('refs/heads/') ? name : `refs/heads/${name}`;
		return this.model(await this.client.createPullRequest(title, body, ref(source), ref(target), draft));
	}

	async edit(number: number, update: IIssueEditData): Promise<PullRequest> {
		return this.model(await this.client.updatePullRequest(number, { title: update.title, description: update.body }));
	}

	async setDraft(number: number, draft: boolean): Promise<PullRequest> {
		return this.model(await this.client.updatePullRequest(number, { isDraft: draft }));
	}

	async close(number: number): Promise<PullRequest> {
		return this.model(await this.client.updatePullRequest(number, { status: 'abandoned' }));
	}

	async reopen(number: number): Promise<PullRequest> {
		return this.model(await this.client.updatePullRequest(number, { status: 'active' }));
	}

	private async reviewedPullRequest(number: number, expectedHead: string): Promise<AzurePullRequest> {
		const pr = await this.client.pullRequest(number);
		if (!expectedHead || pr.lastMergeSourceCommit.commitId !== expectedHead) {
			throw new Error('The pull request source changed. Refresh and review the latest changes before continuing.');
		}
		return pr;
	}

	async merge(number: number, method: MergeMethod, expectedHead: string, deleteSourceBranch: boolean): Promise<PullRequest> {
		const pr = await this.reviewedPullRequest(number, expectedHead);
		const strategies: Record<MergeMethod, string> = { merge: 'noFastForward', squash: 'squash', rebase: 'rebase' };
		return this.model(await this.client.completePullRequest(pr, strategies[method], deleteSourceBranch));
	}

	async mergeability(number: number): Promise<PullRequestMergeability> {
		return mergeability((await this.client.pullRequest(number)).mergeStatus);
	}

	private async commentTarget(number: number, reference: ProviderCommentReference): Promise<{ thread: ReviewThread; comment: ThreadComment; viewer: Identity }> {
		const threadId = positiveId(reference.threadId);
		const commentId = positiveId(reference.commentId);
		const [threads, viewer] = await Promise.all([this.client.threads(number), this.client.currentUser()]);
		const thread = threads.find(thread => thread.id === threadId && !thread.isDeleted);
		const comment = thread?.comments.find(comment => comment.id === commentId && !comment.isDeleted);
		if (!thread || !comment) {
			throw new Error('The comment no longer exists in this pull request thread.');
		}
		if (comment.author.id !== viewer.id) {
			throw new Error('Only the author can edit or delete this comment.');
		}
		return { thread, comment, viewer };
	}

	async addComment(number: number, body: string, threadId?: string): Promise<IComment> {
		const viewer = await this.client.currentUser();
		if (threadId !== undefined) {
			const id = positiveId(threadId);
			const thread = (await this.client.threads(number)).find(thread => thread.id === id && !thread.isDeleted);
			const parent = thread?.comments.find(comment => !comment.isDeleted);
			if (!thread || !parent) {
				throw new Error('The discussion thread no longer exists.');
			}
			return this.comment(number, thread, await this.client.reply(number, id, body, parent.id), viewer);
		}
		const thread = await this.client.createThread(number, body);
		const comment = thread.comments.find(comment => !comment.isDeleted);
		if (!comment) {
			throw new Error('Azure DevOps did not return the new comment. Refresh before trying again.');
		}
		return this.comment(number, thread, comment, viewer);
	}

	async editComment(number: number, reference: ProviderCommentReference, body: string): Promise<IComment> {
		const { thread, comment, viewer } = await this.commentTarget(number, reference);
		return this.comment(number, thread, await this.client.updateComment(number, thread.id, comment.id, body), viewer);
	}

	async deleteComment(number: number, reference: ProviderCommentReference): Promise<void> {
		const { thread, comment } = await this.commentTarget(number, reference);
		await this.client.deleteComment(number, thread.id, comment.id);
	}

	async resolveThread(number: number, threadId: string, resolved: boolean): Promise<void> {
		const id = positiveId(threadId);
		if (!(await this.client.threads(number)).some(thread => thread.id === id && !thread.isDeleted)) {
			throw new Error('The discussion thread no longer exists.');
		}
		await this.client.resolveThread(number, id, resolved);
	}

	async submitReview(number: number, event: ReviewEventEnum, body: string, expectedHead: string): Promise<void> {
		await this.reviewedPullRequest(number, expectedHead);
		const viewer = await this.client.currentUser();
		const key = `${azureRepositoryUrl(this.client.remote)}/pullrequest/${number}`;
		await this.reviews.start(key, viewer.id, expectedHead);
		await this.reviews.setSummary(key, body);
		const threads = await this.client.threads(number);
		const votes: Record<ReviewEventEnum, number> = {
			[ReviewEventEnum.Approve]: 10, [ReviewEventEnum.RequestChanges]: -10, [ReviewEventEnum.Comment]: 0,
		};
		const validate = async () => {
			await this.reviewedPullRequest(number, expectedHead);
			if ((await this.client.currentUser()).id !== viewer.id) {
				throw new Error('The signed-in account changed. Pending review comments were kept.');
			}
		};
		await this.reviews.submit(key, viewer.id, expectedHead, async (draft, marker) => {
			await validate();
			if (threads.some(thread => thread.comments.some(comment =>
				comment.author.id === viewer.id && comment.content?.includes(marker)))) {
				return;
			}
			if (draft.threadId !== undefined) {
				const parent = threads.find(thread => thread.id === draft.threadId && !thread.isDeleted)
					?.comments.find(comment => comment.id === draft.parentCommentId && !comment.isDeleted);
				if (!parent) {
					throw new Error('A pending reply references a discussion that no longer exists.');
				}
				await this.client.reply(number, draft.threadId, `${draft.content}\n\n${marker}`, parent.id);
			} else {
				await this.client.createThread(number, `${draft.content}\n\n${marker}`, draft.context, draft.iteration, draft.changeTrackingId);
			}
		}, async () => {
			await validate();
			if (event !== ReviewEventEnum.Comment) {
				await this.client.vote(number, votes[event], viewer.id);
			}
		});
	}
}
