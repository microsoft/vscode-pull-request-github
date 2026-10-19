/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AzureClient, PullRequest as AzurePullRequest, Identity, PolicyEvaluation, PullRequestStatus, ReviewThread, ThreadComment } from './client';
import { azureRepositoryUrl } from './remote';
import { PendingReviews } from './review';
import { DiffSide, IComment, IReviewThread, SubjectType } from '../common/comment';
import { GitChangeType } from '../common/file';
import { CommentEvent, EventType, ReviewStateValue, TimelineEvent } from '../common/timelineEvent';
import { AccountType, CheckState, IAccount, IIssueEditData, ILabel, MergeMethod, PullRequest, PullRequestChecks, PullRequestMergeability, ReviewEventEnum } from '../github/interface';
import { PROVIDER_PAGE_SIZE, ProviderCommentReference, ProviderDiscussions, ProviderFileChange, ProviderListOptions, ProviderPage, ProviderRepositoryInfo, ProviderRevision, ProviderSection, ProviderSnapshot, PullRequestProvider } from '../providers/pullRequestProvider';

const mergeStrategies: Record<MergeMethod, string> = { merge: 'noFastForward', squash: 'squash', rebase: 'rebase' };

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

function timestamp(value: string | undefined): string {
	if (!value || !Number.isFinite(Date.parse(value))) {
		throw new Error('Azure DevOps did not return a valid timestamp. Refresh before continuing.');
	}
	return value;
}

async function section<T>(load: () => Promise<T>): Promise<ProviderSection<T>> {
	try {
		return { state: 'loaded', value: await load() };
	} catch (error) {
		return { state: 'error', message: error instanceof Error ? error.message : String(error) };
	}
}

export class AzurePullRequestProvider implements PullRequestProvider {
	readonly id = 'azureDevOps';
	readonly capabilities = Object.freeze({
		attachments: false, projects: false, milestones: false, assignees: false,
		mergeQueue: false, stacks: false, autoMerge: true,
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
		if (!pr.lastMergeSourceCommit?.commitId || !pr.lastMergeTargetCommit?.commitId) {
			throw new Error('Azure DevOps has not returned the pull request revisions yet. Refresh before continuing.');
		}
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
			createdAt: timestamp(pr.creationDate),
			updatedAt: timestamp(pr.closedDate ?? pr.creationDate),
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
			allowAutoMerge: true,
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
			createdAt: timestamp(comment.publishedDate),
			url,
			htmlUrl: url,
			diffHunk: '',
			path: (thread.threadContext?.filePath ?? thread.pullRequestThreadContext?.trackingCriteria?.origFilePath)?.replace(/^\//, ''),
			canEdit: viewer.id === comment.author.id,
			canDelete: viewer.id === comment.author.id,
		};
	}

	private thread(number: number, thread: ReviewThread, viewer: Identity, iteration?: number): IReviewThread {
		const context = thread.threadContext;
		const tracking = thread.pullRequestThreadContext?.trackingCriteria;
		const left = !context?.rightFileStart && !!context?.leftFileStart
			|| !context && !tracking?.origRightFileStart && !!tracking?.origLeftFileStart;
		const start = left ? context?.leftFileStart?.line : context?.rightFileStart?.line;
		const end = left ? context?.leftFileEnd?.line : context?.rightFileEnd?.line;
		const originalStart = (left ? tracking?.origLeftFileStart?.line : tracking?.origRightFileStart?.line) ?? start;
		const originalEnd = (left ? tracking?.origLeftFileEnd?.line : tracking?.origRightFileEnd?.line) ?? end ?? originalStart;
		if ([start, end, originalStart, originalEnd].some(line => line !== undefined && (!Number.isSafeInteger(line) || line < 1))
			|| (start !== undefined && end !== undefined && end < start)
			|| (originalStart !== undefined && originalEnd !== undefined && originalEnd < originalStart)) {
			throw new Error('Azure DevOps returned an invalid inline discussion range.');
		}
		const path = context?.filePath ?? tracking?.origFilePath;
		if (!path) {
			throw new Error('Azure DevOps did not return the file for an inline discussion.');
		}
		const mappedIteration = tracking?.secondComparingIteration || thread.pullRequestThreadContext?.iterationContext?.secondComparingIteration;
		const outdated = !context || !!(iteration && mappedIteration && mappedIteration !== iteration);
		const state = String(thread.status).toLowerCase();
		const resolved = ['2', '3', '4', '5', 'fixed', 'wontfix', 'closed', 'bydesign'].includes(state);
		const active = ['1', '6', 'active', 'pending'].includes(state);
		return {
			id: String(thread.id),
			prReviewDatabaseId: thread.id,
			path: path.replace(/^\//, ''),
			diffSide: left ? DiffSide.LEFT : DiffSide.RIGHT,
			startLine: start ?? 0,
			endLine: end ?? start ?? 0,
			originalStartLine: originalStart ?? 0,
			originalEndLine: originalEnd ?? 0,
			isResolved: resolved,
			viewerCanResolve: active,
			viewerCanUnresolve: resolved,
			isOutdated: outdated,
			subjectType: (outdated ? originalStart : start) === undefined ? SubjectType.FILE : SubjectType.LINE,
			comments: thread.comments.filter(comment => !comment.isDeleted && comment.commentType !== 'system' && comment.commentType !== 3)
				.map(comment => this.comment(number, thread, comment, viewer)),
		};
	}

	private mapChecks(policies: PolicyEvaluation[], statuses: PullRequestStatus[]): PullRequestChecks {
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

	async repository(): Promise<ProviderRepositoryInfo> {
		const repository = await this.client.repository();
		return {
			id: repository.id,
			projectId: repository.project.id,
			name: this.client.remote.repository,
			url: azureRepositoryUrl(this.client.remote),
			defaultBranch: repository.defaultBranch?.replace(/^refs\/heads\//, ''),
		};
	}

	async currentUser(): Promise<IAccount> {
		return this.account(await this.client.currentUser());
	}

	async list(options: ProviderListOptions = {}): Promise<ProviderPage<PullRequest>> {
		const skip = options.cursor ?? 0;
		if (!Number.isSafeInteger(skip) || skip < 0) {
			throw new Error('The Azure DevOps pull request page cursor is invalid.');
		}
		const size = PROVIDER_PAGE_SIZE;
		const status = options.status === 'merged' ? 'completed' : options.status === 'closed' ? 'abandoned'
			: options.status === 'all' ? 'all' : 'active';
		const refs = (branch: string | undefined) => branch === undefined || branch.startsWith('refs/heads/') ? branch : `refs/heads/${branch}`;
		const page = await this.client.pullRequestPage(status, skip, size, {
			'searchCriteria.creatorId': options.creatorId,
			'searchCriteria.reviewerId': options.reviewerId,
			'searchCriteria.sourceRefName': refs(options.sourceBranch),
			'searchCriteria.targetRefName': refs(options.targetBranch),
		});
		return { items: page.map(pr => this.model(pr)), nextCursor: page.length === size ? skip + size : undefined };
	}

	async load(number: number): Promise<ProviderSnapshot> {
		const [pr, viewer] = await Promise.all([this.client.pullRequest(number), this.client.currentUser()]);
		const pullRequest = this.model(pr);
		const [discussions, labels, checks, commits] = await Promise.all([
			section(() => this.discussionsFor(number, viewer)), section(() => this.labels(number)),
			section(() => this.checksFor(pr)), section(() => this.commits(number)),
		]);
		if (labels.state === 'loaded') {
			pullRequest.labels = labels.value;
		}
		if (commits.state === 'loaded') {
			pullRequest.commits = commits.value.map(commit => ({ message: commit.message }));
		}
		if (discussions.state === 'loaded') {
			pullRequest.commentCount = discussions.value.events.reduce((count, event) =>
				count + (event.event === EventType.Reviewed ? event.comments.length : event.event === EventType.Commented ? 1 : 0), 0);
		}
		const current = await this.client.pullRequest(number);
		if (current.lastMergeSourceCommit?.commitId !== pr.lastMergeSourceCommit.commitId
			|| current.lastMergeTargetCommit?.commitId !== pr.lastMergeTargetCommit.commitId) {
			throw new Error('The pull request changed while it was loading. Refresh to load a consistent revision.');
		}
		return {
			pullRequest, currentUser: this.account(viewer),
			reviewers: pr.reviewers.map(reviewer => ({ reviewer: this.account(reviewer), state: reviewState(reviewer.vote) })),
			discussions, labels, checks, commits,
		};
	}

	async discussions(number: number): Promise<ProviderDiscussions> {
		return this.discussionsFor(number, await this.client.currentUser());
	}

	private async discussionsFor(number: number, viewer: Identity): Promise<ProviderDiscussions> {
		const iterations = await this.client.iterations(number);
		const latest = iterations.at(-1);
		const threads = (await this.client.threads(number, latest?.id)).filter(thread => !thread.isDeleted);
		const isInline = (thread: ReviewThread) => !!thread.threadContext?.filePath || !!thread.pullRequestThreadContext;
		const inline = threads.filter(isInline).map(thread => this.thread(number, thread, viewer, latest?.id));
		const events: TimelineEvent[] = inline.filter(thread => thread.comments.length > 0).map(thread => {
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
		for (const thread of threads.filter(thread => !isInline(thread))) {
			for (const comment of thread.comments.filter(comment => !comment.isDeleted && comment.commentType !== 'system' && comment.commentType !== 3)) {
				const mapped = this.comment(number, thread, comment, viewer);
				const event: CommentEvent = {
					id: mapped.id, threadId: mapped.threadId, graphNodeId: mapped.graphNodeId, htmlUrl: mapped.htmlUrl,
					body: mapped.body, user: mapped.user, event: EventType.Commented, createdAt: mapped.createdAt,
					canEdit: mapped.canEdit, canDelete: mapped.canDelete,
				};
				events.push(event);
			}
		}
		events.sort((left, right) => {
			const date = (event: TimelineEvent) => event.event === EventType.Reviewed ? event.submittedAt : event.event === EventType.Commented ? event.createdAt : '';
			return Date.parse(date(left)) - Date.parse(date(right));
		});
		return { threads: inline, events };
	}

	private async checksFor(pr: AzurePullRequest): Promise<PullRequestChecks> {
		const [policies, statuses] = await Promise.all([this.client.policies(pr), this.client.statuses(pr.pullRequestId)]);
		return this.mapChecks(policies, statuses);
	}

	async checks(number: number): Promise<PullRequestChecks> {
		return this.checksFor(await this.client.pullRequest(number));
	}

	async labels(number: number): Promise<ILabel[]> {
		return (await this.client.labels(number)).map(label => ({ name: label.name, color: '' }));
	}

	async commits(number: number): Promise<{ sha: string; message: string }[]> {
		return (await this.client.commits(number)).map(commit => ({ sha: commit.commitId, message: commit.comment ?? '' }));
	}

	async revision(number: number): Promise<ProviderRevision> {
		const iteration = (await this.client.iterations(number)).at(-1);
		if (!iteration?.sourceRefCommit?.commitId || !iteration.targetRefCommit?.commitId || !iteration.commonRefCommit?.commitId) {
			throw new Error('Azure DevOps did not return a complete pull request revision. Refresh before continuing.');
		}
		return {
			iteration: iteration.id, source: iteration.sourceRefCommit.commitId,
			target: iteration.targetRefCommit.commitId, mergeBase: iteration.commonRefCommit.commitId,
		};
	}

	async changes(number: number, revision: ProviderRevision): Promise<ProviderFileChange[]> {
		const changeType = (value: string): GitChangeType => {
			if (/\brename\b/i.test(value)) { return GitChangeType.RENAME; }
			if (/\badd\b/i.test(value)) { return GitChangeType.ADD; }
			if (/\bdelete\b/i.test(value)) { return GitChangeType.DELETE; }
			if (/\bedit\b/i.test(value)) { return GitChangeType.MODIFY; }
			throw new Error(`Azure DevOps returned an unsupported file change type: ${value}`);
		};
		return (await this.client.changes(number, revision.iteration)).filter(change => !change.item.isFolder).map(change => ({
			path: change.item.path.replace(/^\//, ''), previousPath: change.originalPath?.replace(/^\//, ''),
			trackingId: change.changeTrackingId, type: changeType(change.changeType),
		}));
	}

	file(path: string, commit: string): Promise<string> {
		return this.client.file(path, commit);
	}

	branches(): Promise<string[]> {
		return this.client.branches();
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
		if (!expectedHead || pr.lastMergeSourceCommit?.commitId !== expectedHead) {
			throw new Error('The pull request source changed. Refresh and review the latest changes before continuing.');
		}
		return pr;
	}

	async merge(number: number, method: MergeMethod, expectedHead: string, deleteSourceBranch: boolean): Promise<PullRequest> {
		const pr = await this.reviewedPullRequest(number, expectedHead);
		return this.model(await this.client.completePullRequest(pr, mergeStrategies[method], deleteSourceBranch));
	}

	async mergeability(number: number): Promise<PullRequestMergeability> {
		return mergeability((await this.client.pullRequest(number)).mergeStatus);
	}

	async setAutoMerge(number: number, method: MergeMethod | undefined, expectedHead: string, deleteSourceBranch: boolean): Promise<PullRequest> {
		const pr = await this.reviewedPullRequest(number, expectedHead);
		if (method === undefined) {
			return this.model(await this.client.updatePullRequest(number, { autoCompleteSetBy: null }));
		}
		return this.model(await this.client.completePullRequest(pr, mergeStrategies[method], deleteSourceBranch, true));
	}

	async setReviewers(number: number, reviewers: IAccount[]): Promise<void> {
		const existing = (await this.client.pullRequest(number)).reviewers;
		const selected = new Set(reviewers.map(reviewer => reviewer.id));
		for (const reviewer of existing.filter(reviewer => !selected.has(reviewer.id))) {
			await this.client.removeReviewer(number, reviewer.id);
		}
		for (const reviewer of reviewers.filter(reviewer => !existing.some(current => current.id === reviewer.id))) {
			await this.client.vote(number, 0, reviewer.id);
		}
	}

	async setLabels(number: number, labels: string[]): Promise<void> {
		const existing = await this.client.labels(number);
		const selected = new Set(labels);
		for (const label of existing.filter(label => !selected.has(label.name))) {
			await this.client.removeLabel(number, label.id);
		}
		for (const name of selected) {
			if (!existing.some(label => label.name === name)) {
				await this.client.addLabel(number, name);
			}
		}
	}

	async retarget(number: number, branch: string): Promise<PullRequest> {
		const targetRefName = branch.startsWith('refs/heads/') ? branch : `refs/heads/${branch}`;
		return this.model(await this.client.updatePullRequest(number, { targetRefName }));
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
		const votes: Record<ReviewEventEnum, 10 | -10 | 0> = {
			[ReviewEventEnum.Approve]: 10, [ReviewEventEnum.RequestChanges]: -10, [ReviewEventEnum.Comment]: 0,
		};
		await this.reviews.setSummary(key, body, votes[event]);
		const threads = await this.client.threads(number);
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
