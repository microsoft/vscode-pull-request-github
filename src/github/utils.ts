/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { Repository } from '../api/api';
import { GitApiImpl } from '../api/api1';
import { IComment, IReviewThread, Reaction } from '../common/comment';
import { DiffHunk, parseDiffHunk } from '../common/diffHunk';
import { Resource } from '../common/resources';
import * as Common from '../common/timelineEvent';
import { uniqBy } from '../common/utils';
import { OctokitCommon } from './common';
import { AuthProvider } from './credentials';
import { SETTINGS_NAMESPACE } from './folderRepositoryManager';
import { GitHubRepository, ViewerPermission } from './githubRepository';
import * as GraphQL from './graphql';
import {
	IAccount,
	IGitHubRef,
	ILabel,
	IMilestone,
	Issue,
	ISuggestedReviewer,
	PullRequest,
	PullRequestMergeability,
	ReviewState,
	User,
} from './interface';
import { GHPRComment, GHPRCommentThread } from './prComment';

export interface CommentReactionHandler {
	toggleReaction(comment: vscode.Comment, reaction: vscode.CommentReaction): Promise<void>;
}

export function createVSCodeCommentThreadForReviewThread(
	uri: vscode.Uri,
	range: vscode.Range,
	thread: IReviewThread,
	commentController: vscode.CommentController,
): GHPRCommentThread {
	const vscodeThread = commentController.createCommentThread(uri, range, []);

	(vscodeThread as GHPRCommentThread).gitHubThreadId = thread.id;

	vscodeThread.comments = thread.comments.map(comment => new GHPRComment(comment, vscodeThread as GHPRCommentThread));
	(vscodeThread as GHPRCommentThread).isResolved = thread.isResolved;

	if (thread.viewerCanResolve && !thread.isResolved) {
		vscodeThread.contextValue = 'canResolve';
	} else if (thread.viewerCanUnresolve && thread.isResolved) {
		vscodeThread.contextValue = 'canUnresolve';
	}

	updateCommentThreadLabel(vscodeThread as GHPRCommentThread);
	vscodeThread.collapsibleState = getCommentCollapsibleState(thread.isResolved);

	return vscodeThread as GHPRCommentThread;
}


export const COMMENT_EXPAND_STATE_SETTING = 'defaultCommentExpandState';
export const COMMENT_EXPAND_STATE_COLLAPSE_VALUE = 'collapseAll';
export const COMMENT_EXPAND_STATE_EXPAND_VALUE = 'expandUnresolved';
export function getCommentCollapsibleState(isResolved: boolean) {
	if (isResolved) {
		return vscode.CommentThreadCollapsibleState.Collapsed;
	}
	const config = vscode.workspace.getConfiguration(SETTINGS_NAMESPACE)?.get(COMMENT_EXPAND_STATE_SETTING);
	return config === COMMENT_EXPAND_STATE_COLLAPSE_VALUE
		? vscode.CommentThreadCollapsibleState.Collapsed : vscode.CommentThreadCollapsibleState.Expanded;
}

export function updateThread(vscodeThread: GHPRCommentThread, reviewThread: IReviewThread) {
	if (reviewThread.viewerCanResolve && !reviewThread.isResolved) {
		vscodeThread.contextValue = 'canResolve';
	} else if (reviewThread.viewerCanUnresolve && reviewThread.isResolved) {
		vscodeThread.contextValue = 'canUnresolve';
	}

	if (vscodeThread.isResolved !== reviewThread.isResolved) {
		vscodeThread.isResolved = reviewThread.isResolved;
	}
	vscodeThread.collapsibleState = getCommentCollapsibleState(reviewThread.isResolved);

	vscodeThread.comments = reviewThread.comments.map(c => new GHPRComment(c, vscodeThread));
	updateCommentThreadLabel(vscodeThread);
}

export function updateCommentThreadLabel(thread: GHPRCommentThread) {
	if (thread.isResolved) {
		thread.label = 'This thread has been marked as resolved';
		return;
	}

	if (thread.comments.length) {
		const participantsList = uniqBy(thread.comments as vscode.Comment[], comment => comment.author.name)
			.map(comment => `@${comment.author.name}`)
			.join(', ');
		thread.label = `Participants: ${participantsList}`;
	} else {
		thread.label = 'Start discussion';
	}
}

export function generateCommentReactions(reactions: Reaction[] | undefined) {
	return getReactionGroup().map(reaction => {
		if (!reactions) {
			return { label: reaction.label, authorHasReacted: false, count: 0, iconPath: reaction.icon || '' };
		}

		const matchedReaction = reactions.find(re => re.label === reaction.label);

		if (matchedReaction) {
			return {
				label: matchedReaction.label,
				authorHasReacted: matchedReaction.viewerHasReacted,
				count: matchedReaction.count,
				iconPath: reaction.icon || '',
			};
		} else {
			return { label: reaction.label, authorHasReacted: false, count: 0, iconPath: reaction.icon || '' };
		}
	});
}
export function updateCommentReactions(comment: vscode.Comment, reactions: Reaction[] | undefined) {
	comment.reactions = generateCommentReactions(reactions);
}

export function updateCommentReviewState(thread: GHPRCommentThread, newDraftMode: boolean) {
	if (newDraftMode) {
		return;
	}

	thread.comments = thread.comments.map(comment => {
		if (comment instanceof GHPRComment) {
			comment._rawComment.isDraft = false;
		}

		comment.label = undefined;

		return comment;
	});
}

export function convertRESTUserToAccount(
	user: OctokitCommon.PullsListResponseItemUser,
	githubRepository: GitHubRepository,
): IAccount {
	return {
		login: user.login,
		url: user.html_url,
		avatarUrl: getAvatarWithEnterpriseFallback(user.avatar_url, user.gravatar_id ?? undefined, githubRepository.remote.authProviderId),
	};
}

export function convertRESTHeadToIGitHubRef(head: OctokitCommon.PullsListResponseItemHead) {
	return {
		label: head.label,
		ref: head.ref,
		sha: head.sha,
		repo: { cloneUrl: head.repo.clone_url },
	};
}

export function convertRESTPullRequestToRawPullRequest(
	pullRequest:
		| OctokitCommon.PullsCreateResponseData
		| OctokitCommon.PullsGetResponseData
		| OctokitCommon.PullsListResponseItem,
	githubRepository: GitHubRepository,
): PullRequest {
	const {
		number,
		body,
		title,
		html_url,
		user,
		state,
		assignees,
		created_at,
		updated_at,
		head,
		base,
		labels,
		node_id,
		id,
		draft,
	} = pullRequest;

	const item: PullRequest = {
		id,
		graphNodeId: node_id,
		number,
		body: body ?? '',
		title,
		url: html_url,
		user: convertRESTUserToAccount(user!, githubRepository),
		state,
		merged: (pullRequest as OctokitCommon.PullsGetResponseData).merged || false,
		assignees: assignees
			? assignees.map(assignee => convertRESTUserToAccount(assignee!, githubRepository))
			: undefined,
		createdAt: created_at,
		updatedAt: updated_at,
		head: convertRESTHeadToIGitHubRef(head),
		base: convertRESTHeadToIGitHubRef(base),
		mergeable: (pullRequest as OctokitCommon.PullsGetResponseData).mergeable
			? PullRequestMergeability.Mergeable
			: PullRequestMergeability.NotMergeable,
		labels: labels.map<ILabel>(l => ({ name: '', color: '', ...l })),
		isDraft: draft,
		suggestedReviewers: [], // suggested reviewers only available through GraphQL API
	};

	return item;
}

export function convertRESTIssueToRawPullRequest(
	pullRequest: OctokitCommon.IssuesCreateResponseData,
	githubRepository: GitHubRepository,
): PullRequest {
	const {
		number,
		body,
		title,
		html_url,
		user,
		state,
		assignees,
		created_at,
		updated_at,
		labels,
		node_id,
		id,
	} = pullRequest;

	const item: PullRequest = {
		id,
		graphNodeId: node_id,
		number,
		body: body ?? '',
		title,
		url: html_url,
		user: convertRESTUserToAccount(user!, githubRepository),
		state,
		assignees: assignees
			? assignees.map(assignee => convertRESTUserToAccount(assignee!, githubRepository))
			: undefined,
		createdAt: created_at,
		updatedAt: updated_at,
		labels: labels.map<ILabel>(l =>
			typeof l === 'string' ? { name: l, color: '' } : { name: l.name ?? '', color: l.color ?? '' },
		),
		suggestedReviewers: [], // suggested reviewers only available through GraphQL API
	};

	return item;
}

export function convertRESTReviewEvent(
	review: OctokitCommon.PullsCreateReviewResponseData,
	githubRepository: GitHubRepository,
): Common.ReviewEvent {
	return {
		event: Common.EventType.Reviewed,
		comments: [],
		submittedAt: (review as any).submitted_at, // TODO fix typings upstream
		body: review.body,
		bodyHTML: review.body,
		htmlUrl: review.html_url,
		user: convertRESTUserToAccount(review.user!, githubRepository),
		authorAssociation: review.user!.type,
		state: review.state as 'COMMENTED' | 'APPROVED' | 'CHANGES_REQUESTED' | 'PENDING',
		id: review.id,
	};
}

export function parseCommentDiffHunk(comment: IComment): DiffHunk[] {
	const diffHunks: DiffHunk[] = [];
	const diffHunkReader = parseDiffHunk(comment.diffHunk);
	let diffHunkIter = diffHunkReader.next();

	while (!diffHunkIter.done) {
		const diffHunk = diffHunkIter.value;
		diffHunks.push(diffHunk);
		diffHunkIter = diffHunkReader.next();
	}

	return diffHunks;
}

export function convertPullRequestsGetCommentsResponseItemToComment(
	comment: OctokitCommon.PullsCreateReviewCommentResponseData,
	githubRepository: GitHubRepository,
): IComment {
	const ret: IComment = {
		url: comment.url,
		id: comment.id,
		pullRequestReviewId: comment.pull_request_review_id ?? undefined,
		diffHunk: comment.diff_hunk,
		path: comment.path,
		position: comment.position,
		commitId: comment.commit_id,
		originalPosition: comment.original_position,
		originalCommitId: comment.original_commit_id,
		user: convertRESTUserToAccount(comment.user!, githubRepository),
		body: comment.body,
		createdAt: comment.created_at,
		htmlUrl: comment.html_url,
		inReplyToId: comment.in_reply_to_id,
		graphNodeId: comment.node_id,
	};

	const diffHunks = parseCommentDiffHunk(ret);
	ret.diffHunks = diffHunks;
	return ret;
}

export function convertGraphQLEventType(text: string) {
	switch (text) {
		case 'PullRequestCommit':
			return Common.EventType.Committed;
		case 'LabeledEvent':
			return Common.EventType.Labeled;
		case 'MilestonedEvent':
			return Common.EventType.Milestoned;
		case 'AssignedEvent':
			return Common.EventType.Assigned;
		case 'HeadRefDeletedEvent':
			return Common.EventType.HeadRefDeleted;
		case 'IssueComment':
			return Common.EventType.Commented;
		case 'PullRequestReview':
			return Common.EventType.Reviewed;
		case 'MergedEvent':
			return Common.EventType.Merged;

		default:
			return Common.EventType.Other;
	}
}

export function parseGraphQLReviewThread(thread: GraphQL.ReviewThread): IReviewThread {
	return {
		id: thread.id,
		isResolved: thread.isResolved,
		viewerCanResolve: thread.viewerCanResolve,
		viewerCanUnresolve: thread.viewerCanUnresolve,
		path: thread.path,
		line: thread.line,
		originalLine: thread.originalLine,
		diffSide: thread.diffSide,
		isOutdated: thread.isOutdated,
		comments: thread.comments.nodes.map(comment => parseGraphQLComment(comment, thread.isResolved)),
	};
}

export function parseGraphQLComment(comment: GraphQL.ReviewComment, isResolved: boolean): IComment {
	const c: IComment = {
		id: comment.databaseId,
		url: comment.url,
		body: comment.body,
		bodyHTML: comment.bodyHTML,
		path: comment.path,
		canEdit: comment.viewerCanDelete,
		canDelete: comment.viewerCanDelete,
		pullRequestReviewId: comment.pullRequestReview && comment.pullRequestReview.databaseId,
		diffHunk: comment.diffHunk,
		position: comment.position,
		commitId: comment.commit.oid,
		originalPosition: comment.originalPosition,
		originalCommitId: comment.originalCommit && comment.originalCommit.oid,
		user: comment.author,
		createdAt: comment.createdAt,
		htmlUrl: comment.url,
		graphNodeId: comment.id,
		isDraft: comment.state === 'PENDING',
		inReplyToId: comment.replyTo && comment.replyTo.databaseId,
		reactions: parseGraphQLReaction(comment.reactionGroups),
		isResolved,
	};

	const diffHunks = parseCommentDiffHunk(c);
	c.diffHunks = diffHunks;

	return c;
}

export function parseGraphQlIssueComment(comment: GraphQL.IssueComment): IComment {
	return {
		id: comment.databaseId,
		url: comment.url,
		body: comment.body,
		bodyHTML: comment.bodyHTML,
		canEdit: comment.viewerCanDelete,
		canDelete: comment.viewerCanDelete,
		user: comment.author,
		createdAt: comment.createdAt,
		htmlUrl: comment.url,
		graphNodeId: comment.id,
		diffHunk: '',
	};
}

export function parseGraphQLReaction(reactionGroups: GraphQL.ReactionGroup[]): Reaction[] {
	const reactionContentEmojiMapping = getReactionGroup().reduce((prev, curr) => {
		prev[curr.title] = curr;
		return prev;
	}, {} as { [key: string]: { title: string; label: string; icon?: vscode.Uri } });

	const reactions = reactionGroups
		.filter(group => group.users.totalCount > 0)
		.map(group => {
			const reaction: Reaction = {
				label: reactionContentEmojiMapping[group.content].label,
				count: group.users.totalCount,
				icon: reactionContentEmojiMapping[group.content].icon,
				viewerHasReacted: group.viewerHasReacted,
			};

			return reaction;
		});

	return reactions;
}

function parseRef(refName: string, oid: string, repository?: GraphQL.RefRepository): IGitHubRef | undefined {
	if (!repository) {
		return undefined;
	}

	return {
		label: `${repository.owner.login}:${refName}`,
		ref: refName,
		sha: oid,
		repo: {
			cloneUrl: repository.url,
		},
	};
}

function parseAuthor(
	author: { login: string; url: string; avatarUrl: string; email?: string } | null,
	githubRepository: GitHubRepository,
): IAccount {
	if (author) {
		return {
			login: author.login,
			url: author.url,
			avatarUrl: getAvatarWithEnterpriseFallback(author.avatarUrl, undefined, githubRepository.remote.authProviderId),
			email: author.email
		};
	} else {
		return {
			login: '',
			url: '',
		};
	}
}

export function parseMilestone(
	milestone: { title: string; dueOn?: string; createdAt: string; id: string } | undefined,
): IMilestone | undefined {
	if (!milestone) {
		return undefined;
	}
	return {
		title: milestone.title,
		dueOn: milestone.dueOn,
		createdAt: milestone.createdAt,
		id: milestone.id,
	};
}

export function parseMergeability(mergeability: 'UNKNOWN' | 'MERGEABLE' | 'CONFLICTING'): PullRequestMergeability {
	switch (mergeability) {
		case 'UNKNOWN':
			return PullRequestMergeability.Unknown;
		case 'MERGEABLE':
			return PullRequestMergeability.Mergeable;
		case 'CONFLICTING':
			return PullRequestMergeability.NotMergeable;
	}
}

export function parseGraphQLPullRequest(
	pullRequest: GraphQL.PullRequestResponse,
	githubRepository: GitHubRepository,
): PullRequest {
	const graphQLPullRequest = pullRequest.repository.pullRequest;

	return {
		id: graphQLPullRequest.databaseId,
		graphNodeId: graphQLPullRequest.id,
		url: graphQLPullRequest.url,
		number: graphQLPullRequest.number,
		state: graphQLPullRequest.state,
		body: graphQLPullRequest.body,
		bodyHTML: graphQLPullRequest.bodyHTML,
		title: graphQLPullRequest.title,
		createdAt: graphQLPullRequest.createdAt,
		updatedAt: graphQLPullRequest.updatedAt,
		isRemoteHeadDeleted: !graphQLPullRequest.headRef,
		head: parseRef(graphQLPullRequest.headRef?.name ?? graphQLPullRequest.headRefName, graphQLPullRequest.headRefOid, graphQLPullRequest.headRepository),
		isRemoteBaseDeleted: !graphQLPullRequest.baseRef,
		base: parseRef(graphQLPullRequest.baseRef?.name ?? graphQLPullRequest.baseRefName, graphQLPullRequest.baseRefOid, graphQLPullRequest.baseRepository),
		user: parseAuthor(graphQLPullRequest.author, githubRepository),
		merged: graphQLPullRequest.merged,
		mergeable: parseMergeability(graphQLPullRequest.mergeable),
		labels: graphQLPullRequest.labels.nodes,
		isDraft: graphQLPullRequest.isDraft,
		suggestedReviewers: parseSuggestedReviewers(graphQLPullRequest.suggestedReviewers),
		comments: parseComments(graphQLPullRequest.comments?.nodes, githubRepository),
		milestone: parseMilestone(graphQLPullRequest.milestone),
		assignees: graphQLPullRequest.assignees?.nodes.map(assignee => parseAuthor(assignee, githubRepository)),
	};
}

function parseComments(comments: GraphQL.AbbreviatedIssueComment[] | undefined, githubRepository: GitHubRepository) {
	if (!comments) {
		return;
	}
	const parsedComments: {
		author: IAccount;
		body: string;
		databaseId: number;
	}[] = [];
	for (const comment of comments) {
		parsedComments.push({
			author: parseAuthor(comment.author, githubRepository),
			body: comment.body,
			databaseId: comment.databaseId,
		});
	}

	return parsedComments;
}

export function parseGraphQLIssue(issue: GraphQL.PullRequest, githubRepository: GitHubRepository): Issue {
	return {
		id: issue.databaseId,
		graphNodeId: issue.id,
		url: issue.url,
		number: issue.number,
		state: issue.state,
		body: issue.body,
		bodyHTML: issue.bodyHTML,
		title: issue.title,
		createdAt: issue.createdAt,
		updatedAt: issue.updatedAt,
		assignees: issue.assignees?.nodes.map(assignee => parseAuthor(assignee, githubRepository)),
		user: parseAuthor(issue.author, githubRepository),
		labels: issue.labels.nodes,
		repositoryName: issue.repository?.name,
		repositoryOwner: issue.repository?.owner.login,
		repositoryUrl: issue.repository?.url,
	};
}

export function parseGraphQLIssuesRequest(
	pullRequest: GraphQL.PullRequest,
	githubRepository: GitHubRepository,
): PullRequest {
	const graphQLPullRequest = pullRequest;

	return {
		id: graphQLPullRequest.databaseId,
		graphNodeId: graphQLPullRequest.id,
		url: graphQLPullRequest.url,
		number: graphQLPullRequest.number,
		state: graphQLPullRequest.state,
		body: graphQLPullRequest.body,
		bodyHTML: graphQLPullRequest.bodyHTML,
		title: graphQLPullRequest.title,
		createdAt: graphQLPullRequest.createdAt,
		updatedAt: graphQLPullRequest.updatedAt,
		isRemoteHeadDeleted: !graphQLPullRequest.headRef,
		head: parseRef(graphQLPullRequest.headRef?.name ?? graphQLPullRequest.headRefName, graphQLPullRequest.headRefOid, graphQLPullRequest.headRepository),
		isRemoteBaseDeleted: !graphQLPullRequest.baseRef,
		base: parseRef(graphQLPullRequest.baseRef?.name ?? graphQLPullRequest.baseRefName, graphQLPullRequest.baseRefOid, graphQLPullRequest.baseRepository),
		user: parseAuthor(graphQLPullRequest.author, githubRepository),
		merged: graphQLPullRequest.merged,
		mergeable: parseMergeability(graphQLPullRequest.mergeable),
		labels: graphQLPullRequest.labels.nodes,
		isDraft: graphQLPullRequest.isDraft,
		suggestedReviewers: parseSuggestedReviewers(graphQLPullRequest.suggestedReviewers),
		milestone: parseMilestone(graphQLPullRequest.milestone),
	};
}

function parseSuggestedReviewers(
	suggestedReviewers: GraphQL.SuggestedReviewerResponse[] | undefined,
): ISuggestedReviewer[] {
	if (!suggestedReviewers) {
		return [];
	}
	const ret: ISuggestedReviewer[] = suggestedReviewers.map(suggestedReviewer => {
		return {
			login: suggestedReviewer.reviewer.login,
			avatarUrl: suggestedReviewer.reviewer.avatarUrl,
			name: suggestedReviewer.reviewer.name,
			url: suggestedReviewer.reviewer.url,
			isAuthor: suggestedReviewer.isAuthor,
			isCommenter: suggestedReviewer.isCommenter,
		};
	});

	return ret.sort(loginComparator);
}

/**
 * Used for case insensitive sort by login
 */
export function loginComparator(a: IAccount, b: IAccount) {
	// sensitivity: 'accent' allows case insensitive comparison
	return a.login.localeCompare(b.login, 'en', { sensitivity: 'accent' });
}

export function parseGraphQLReviewEvent(
	review: GraphQL.SubmittedReview,
	githubRepository: GitHubRepository,
): Common.ReviewEvent {
	return {
		event: Common.EventType.Reviewed,
		comments: review.comments.nodes.map(comment => parseGraphQLComment(comment, false)).filter(c => !c.inReplyToId),
		submittedAt: review.submittedAt,
		body: review.body,
		bodyHTML: review.bodyHTML,
		htmlUrl: review.url,
		user: parseAuthor(review.author, githubRepository),
		authorAssociation: review.authorAssociation,
		state: review.state,
		id: review.databaseId,
	};
}

export function parseGraphQLTimelineEvents(
	events: (
		| GraphQL.MergedEvent
		| GraphQL.Review
		| GraphQL.IssueComment
		| GraphQL.Commit
		| GraphQL.AssignedEvent
		| GraphQL.HeadRefDeletedEvent
	)[],
	githubRepository: GitHubRepository,
): Common.TimelineEvent[] {
	const normalizedEvents: Common.TimelineEvent[] = [];
	events.forEach(event => {
		const type = convertGraphQLEventType(event.__typename);

		switch (type) {
			case Common.EventType.Commented:
				const commentEvent = event as GraphQL.IssueComment;
				normalizedEvents.push({
					htmlUrl: commentEvent.url,
					body: commentEvent.body,
					bodyHTML: commentEvent.bodyHTML,
					user: parseAuthor(commentEvent.author, githubRepository),
					event: type,
					canEdit: commentEvent.viewerCanUpdate,
					canDelete: commentEvent.viewerCanDelete,
					id: commentEvent.databaseId,
					graphNodeId: commentEvent.id,
					createdAt: commentEvent.createdAt,
				});
				return;
			case Common.EventType.Reviewed:
				const reviewEvent = event as GraphQL.Review;
				normalizedEvents.push({
					event: type,
					comments: [],
					submittedAt: reviewEvent.submittedAt,
					body: reviewEvent.body,
					bodyHTML: reviewEvent.bodyHTML,
					htmlUrl: reviewEvent.url,
					user: parseAuthor(reviewEvent.author, githubRepository),
					authorAssociation: reviewEvent.authorAssociation,
					state: reviewEvent.state,
					id: reviewEvent.databaseId,
				});
				return;
			case Common.EventType.Committed:
				const commitEv = event as GraphQL.Commit;
				normalizedEvents.push({
					id: commitEv.databaseId,
					event: type,
					sha: commitEv.commit.oid,
					author: commitEv.commit.author.user
						? parseAuthor(commitEv.commit.author.user, githubRepository)
						: { login: commitEv.commit.committer.name },
					htmlUrl: commitEv.url,
					message: commitEv.commit.message,
					authoredDate: new Date(commitEv.commit.authoredDate),
				} as Common.CommitEvent); // TODO remove cast
				return;
			case Common.EventType.Merged:
				const mergeEv = event as GraphQL.MergedEvent;

				normalizedEvents.push({
					id: mergeEv.databaseId,
					event: type,
					user: parseAuthor(mergeEv.actor, githubRepository),
					createdAt: mergeEv.createdAt,
					mergeRef: mergeEv.mergeRef.name,
					sha: mergeEv.commit.oid,
					commitUrl: mergeEv.commit.commitUrl,
					url: mergeEv.url,
					graphNodeId: mergeEv.id,
				});
				return;
			case Common.EventType.Assigned:
				const assignEv = event as GraphQL.AssignedEvent;

				normalizedEvents.push({
					id: assignEv.databaseId,
					event: type,
					user: assignEv.user,
					actor: assignEv.actor,
				});
				return;
			case Common.EventType.HeadRefDeleted:
				const deletedEv = event as GraphQL.HeadRefDeletedEvent;

				normalizedEvents.push({
					id: deletedEv.id,
					event: type,
					actor: deletedEv.actor,
					createdAt: deletedEv.createdAt,
					headRef: deletedEv.headRefName,
				});
				return;
			default:
				break;
		}
	});

	return normalizedEvents;
}

export function parseGraphQLUser(user: GraphQL.UserResponse, githubRepository: GitHubRepository): User {
	return {
		login: user.user.login,
		name: user.user.name,
		avatarUrl: user.user.avatarUrl ? getAvatarWithEnterpriseFallback(user.user.avatarUrl, undefined, githubRepository.remote.authProviderId) : undefined,
		url: user.user.url,
		bio: user.user.bio,
		company: user.user.company,
		location: user.user.location,
		commitContributions: parseGraphQLCommitContributions(user.user.contributionsCollection),
	};
}

function parseGraphQLCommitContributions(
	commitComments: GraphQL.ContributionsCollection,
): { createdAt: Date; repoNameWithOwner: string }[] {
	const items: { createdAt: Date; repoNameWithOwner: string }[] = [];
	commitComments.commitContributionsByRepository.forEach(repoCommits => {
		repoCommits.contributions.nodes.forEach(commit => {
			items.push({
				createdAt: new Date(commit.occurredAt),
				repoNameWithOwner: repoCommits.repository.nameWithOwner,
			});
		});
	});
	return items;
}

export function getReactionGroup(): { title: string; label: string; icon?: vscode.Uri }[] {
	const ret = [
		{
			title: 'THUMBS_UP',
			label: '👍',
			icon: Resource.icons.reactions.THUMBS_UP,
		},
		{
			title: 'THUMBS_DOWN',
			label: '👎',
			icon: Resource.icons.reactions.THUMBS_DOWN,
		},
		{
			title: 'LAUGH',
			label: '😄',
			icon: Resource.icons.reactions.LAUGH,
		},
		{
			title: 'HOORAY',
			label: '🎉',
			icon: Resource.icons.reactions.HOORAY,
		},
		{
			title: 'CONFUSED',
			label: '😕',
			icon: Resource.icons.reactions.CONFUSED,
		},
		{
			title: 'HEART',
			label: '❤️',
			icon: Resource.icons.reactions.HEART,
		},
		{
			title: 'ROCKET',
			label: '🚀',
			icon: Resource.icons.reactions.ROCKET,
		},
		{
			title: 'EYES',
			label: '👀',
			icon: Resource.icons.reactions.EYES,
		},
	];

	return ret;
}

export function getRelatedUsersFromTimelineEvents(
	timelineEvents: Common.TimelineEvent[],
): { login: string; name: string }[] {
	const ret: { login: string; name: string }[] = [];

	timelineEvents.forEach(event => {
		if (Common.isCommitEvent(event)) {
			ret.push({
				login: event.author.login,
				name: event.author.name || '',
			});
		}

		if (Common.isReviewEvent(event)) {
			ret.push({
				login: event.user.login,
				name: event.user.name ?? event.user.login,
			});
		}

		if (Common.isCommentEvent(event)) {
			ret.push({
				login: event.user.login,
				name: event.user.name ?? event.user.login,
			});
		}
	});

	return ret;
}

export function parseGraphQLViewerPermission(
	viewerPermissionResponse: GraphQL.ViewerPermissionResponse,
): ViewerPermission {
	if (viewerPermissionResponse && viewerPermissionResponse.repository.viewerPermission) {
		if (
			(Object.values(ViewerPermission) as string[]).includes(viewerPermissionResponse.repository.viewerPermission)
		) {
			return viewerPermissionResponse.repository.viewerPermission as ViewerPermission;
		}
	}
	return ViewerPermission.Unknown;
}

export function getRepositoryForFile(gitAPI: GitApiImpl, file: vscode.Uri): Repository | undefined {
	for (const repository of gitAPI.repositories) {
		if (
			file.path.toLowerCase() === repository.rootUri.path.toLowerCase() ||
			(file.path.toLowerCase().startsWith(repository.rootUri.path.toLowerCase()) &&
				file.path.substring(repository.rootUri.path.length).startsWith('/'))
		) {
			return repository;
		}
	}
	return undefined;
}

/**
 * Create a list of reviewers composed of people who have already left reviews on the PR, and
 * those that have had a review requested of them. If a reviewer has left multiple reviews, the
 * state should be the state of their most recent review, or 'REQUESTED' if they have an outstanding
 * review request.
 * @param requestedReviewers The list of reviewers that are requested for this pull request
 * @param timelineEvents All timeline events for the pull request
 * @param author The author of the pull request
 */
export function parseReviewers(
	requestedReviewers: IAccount[],
	timelineEvents: Common.TimelineEvent[],
	author: IAccount,
): ReviewState[] {
	const reviewEvents = timelineEvents.filter(Common.isReviewEvent).filter(event => event.state !== 'PENDING');
	let reviewers: ReviewState[] = [];
	const seen = new Map<string, boolean>();

	// Do not show the author in the reviewer list
	seen.set(author.login, true);

	for (let i = reviewEvents.length - 1; i >= 0; i--) {
		const reviewer = reviewEvents[i].user;
		if (!seen.get(reviewer.login)) {
			seen.set(reviewer.login, true);
			reviewers.push({
				reviewer: reviewer,
				state: reviewEvents[i].state,
			});
		}
	}

	requestedReviewers.forEach(request => {
		if (!seen.get(request.login)) {
			reviewers.push({
				reviewer: request,
				state: 'REQUESTED',
			});
		} else {
			const reviewer = reviewers.find(r => r.reviewer.login === request.login);
			reviewer!.state = 'REQUESTED';
		}
	});

	// Put completed reviews before review requests and alphabetize each section
	reviewers = reviewers.sort((a, b) => {
		if (a.state === 'REQUESTED' && b.state !== 'REQUESTED') {
			return 1;
		}

		if (b.state === 'REQUESTED' && a.state !== 'REQUESTED') {
			return -1;
		}

		return a.reviewer.login.toLowerCase() < b.reviewer.login.toLowerCase() ? -1 : 1;
	});

	return reviewers;
}

export function getPRFetchQuery(repo: string, user: string, query: string): string {
	const filter = query.replace(/\$\{user\}/g, user);
	return `is:pull-request ${filter} type:pr repo:${repo}`;
}

export function isInCodespaces(): boolean {
	return vscode.env.remoteName === 'codespaces' && vscode.env.uiKind === vscode.UIKind.Web;
}

export function getEnterpriseUri(): vscode.Uri | undefined {
	const config: string = vscode.workspace.getConfiguration('github-enterprise').get<string>('uri', '');
	if (config) {
		return vscode.Uri.parse(config, true);
	}
}

export function hasEnterpriseUri(): boolean {
	return !!getEnterpriseUri();
}

export function generateGravatarUrl(gravatarId: string | undefined, size: number = 200): string | undefined {
	return !!gravatarId ? `https://www.gravatar.com/avatar/${gravatarId}?s=${size}&d=retro` : undefined;
}

export function getAvatarWithEnterpriseFallback(avatarUrl: string, email: string | undefined, authProviderId: AuthProvider): string | undefined {
	return authProviderId === AuthProvider.github ? avatarUrl : (email ? generateGravatarUrl(
		crypto.createHash('md5').update(email?.trim()?.toLowerCase()).digest('hex')) : undefined);
}
