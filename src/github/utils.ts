/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as Octokit from '@octokit/rest';
import * as vscode from 'vscode';
import { IAccount, PullRequest, IGitHubRef, PullRequestMergeability, ISuggestedReviewer, IMilestone, User, Issue } from './interface';
import { IComment, Reaction } from '../common/comment';
import { parseDiffHunk, DiffHunk } from '../common/diffHunk';
import * as Common from '../common/timelineEvent';
import * as GraphQL from './graphql';
import { Resource } from '../common/resources';
import { uniqBy } from '../common/utils';
import { GitHubRepository } from './githubRepository';
import { GHPRCommentThread, GHPRComment } from './prComment';
import { ThreadData } from '../view/treeNodes/pullRequestNode';

export interface CommentReactionHandler {
	toggleReaction(comment: vscode.Comment, reaction: vscode.CommentReaction): Promise<void>;
}
export function createVSCodeCommentThread(thread: ThreadData, commentController: vscode.CommentController): GHPRCommentThread {
	const vscodeThread = commentController.createCommentThread(
		thread.uri,
		thread.range!,
		[]
	);

	vscodeThread.threadId = thread.threadId;

	vscodeThread.comments = thread.comments.map(comment => new GHPRComment(comment, vscodeThread as GHPRCommentThread));

	updateCommentThreadLabel(vscodeThread as GHPRCommentThread);
	vscodeThread.collapsibleState = thread.collapsibleState;
	return vscodeThread as GHPRCommentThread;
}

export function updateCommentThreadLabel(thread: GHPRCommentThread) {
	if (thread.comments.length) {
		const participantsList = uniqBy(thread.comments as vscode.Comment[], comment => comment.author.name).map(comment => `@${comment.author.name}`).join(', ');
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
			return { label: matchedReaction.label, authorHasReacted: matchedReaction.viewerHasReacted, count: matchedReaction.count, iconPath: reaction.icon || '' };
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

export function convertRESTUserToAccount(user: Octokit.PullsListResponseItemUser, githubRepository: GitHubRepository): IAccount {
	return {
		login: user.login,
		url: user.html_url,
		avatarUrl: githubRepository.isGitHubDotCom ? user.avatar_url : undefined
	};
}

export function convertRESTHeadToIGitHubRef(head: Octokit.PullsListResponseItemHead) {
	return {
		label: head.label,
		ref: head.ref,
		sha: head.sha,
		repo: { cloneUrl: head.repo.clone_url }
	};
}

export function convertRESTPullRequestToRawPullRequest(pullRequest: Octokit.PullsCreateResponse | Octokit.PullsGetResponse | Octokit.PullsListResponseItem, githubRepository: GitHubRepository): PullRequest {
	const {
		number,
		body,
		title,
		html_url,
		user,
		state,
		assignee,
		created_at,
		updated_at,
		head,
		base,
		labels,
		node_id,
		id,
		draft
	} = pullRequest;

	const item: PullRequest = {
		id,
		graphNodeId: node_id,
		number,
		body,
		title,
		url: html_url,
		user: convertRESTUserToAccount(user, githubRepository),
		state,
		merged: (pullRequest as Octokit.PullsGetResponse).merged || false,
		assignee: assignee ? convertRESTUserToAccount(assignee, githubRepository) : undefined,
		createdAt: created_at,
		updatedAt: updated_at,
		head: convertRESTHeadToIGitHubRef(head),
		base: convertRESTHeadToIGitHubRef(base),
		mergeable: (pullRequest as Octokit.PullsGetResponse).mergeable ? PullRequestMergeability.Mergeable : PullRequestMergeability.NotMergeable,
		labels,
		isDraft: draft,
		suggestedReviewers: [] // suggested reviewers only available through GraphQL API
	};

	return item;
}

export function convertRESTIssueToRawPullRequest(pullRequest: Octokit.IssuesCreateResponse | Octokit.IssuesGetResponse | Octokit.IssuesListResponseItem, githubRepository: GitHubRepository): PullRequest {
	const {
		number,
		body,
		title,
		html_url,
		user,
		state,
		assignee,
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
		body,
		title,
		url: html_url,
		user: convertRESTUserToAccount(user, githubRepository),
		state,
		assignee: assignee ? convertRESTUserToAccount(assignee, githubRepository) : undefined,
		createdAt: created_at,
		updatedAt: updated_at,
		labels,
		suggestedReviewers: [] // suggested reviewers only available through GraphQL API
	};

	return item;
}

export function convertRESTReviewEvent(review: Octokit.PullsCreateReviewResponse, githubRepository: GitHubRepository): Common.ReviewEvent {
	return {
		event: Common.EventType.Reviewed,
		comments: [],
		submittedAt: (review as any).submitted_at, // TODO fix typings upstream
		body: review.body,
		htmlUrl: review.html_url,
		user: convertRESTUserToAccount(review.user, githubRepository),
		authorAssociation: review.user.type,
		state: review.state as 'COMMENTED' | 'APPROVED' | 'CHANGES_REQUESTED' | 'PENDING',
		id: review.id
	};
}

export function parseCommentDiffHunk(comment: IComment): DiffHunk[] {
	const diffHunks = [];
	const diffHunkReader = parseDiffHunk(comment.diffHunk);
	let diffHunkIter = diffHunkReader.next();

	while (!diffHunkIter.done) {
		const diffHunk = diffHunkIter.value;
		diffHunks.push(diffHunk);
		diffHunkIter = diffHunkReader.next();
	}

	return diffHunks;
}

export function convertPullRequestsGetCommentsResponseItemToComment(comment: Octokit.PullsListCommentsResponseItem | Octokit.PullsUpdateCommentResponse, githubRepository: GitHubRepository): IComment {
	const ret: IComment = {
		url: comment.url,
		id: comment.id,
		pullRequestReviewId: comment.pull_request_review_id,
		diffHunk: comment.diff_hunk,
		path: comment.path,
		position: comment.position,
		commitId: comment.commit_id,
		originalPosition: comment.original_position,
		originalCommitId: comment.original_commit_id,
		user: convertRESTUserToAccount(comment.user, githubRepository),
		body: comment.body,
		createdAt: comment.created_at,
		htmlUrl: comment.html_url,
		inReplyToId: comment.in_reply_to_id,
		graphNodeId: comment.node_id
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

export function parseGraphQLComment(comment: GraphQL.ReviewComment): IComment {
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
		reactions: parseGraphQLReaction(comment.reactionGroups)
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
		diffHunk: ''
	};
}

export function parseGraphQLReaction(reactionGroups: GraphQL.ReactionGroup[]): Reaction[] {
	const reactionConentEmojiMapping = getReactionGroup().reduce((prev, curr) => {
		prev[curr.title] = curr;
		return prev;
	}, {} as { [key: string]: { title: string; label: string; icon?: vscode.Uri } });

	const reactions = reactionGroups.filter(group => group.users.totalCount > 0).map(group => {
		const reaction: Reaction = {
			label: reactionConentEmojiMapping[group.content].label,
			count: group.users.totalCount,
			icon: reactionConentEmojiMapping[group.content].icon,
			viewerHasReacted: group.viewerHasReacted
		};

		return reaction;
	});

	return reactions;
}

function parseRef(ref: GraphQL.Ref | undefined): IGitHubRef | undefined {
	if (ref) {
		return {
			label: `${ref.repository.owner.login}:${ref.name}`,
			ref: ref.name,
			sha: ref.target.oid,
			repo: {
				cloneUrl: ref.repository.url
			}
		};
	}
}

function parseAuthor(author: { login: string, url: string, avatarUrl: string } | null, githubRepository: GitHubRepository): IAccount {
	if (author) {
		return {
			login: author.login,
			url: author.url,
			avatarUrl: githubRepository.isGitHubDotCom ? author.avatarUrl : undefined
		};
	} else {
		return {
			login: '',
			url: ''
		};
	}
}

export function parseMilestone(milestone: { title: string, dueOn?: string, createdAt?: string, id?: string } | undefined): IMilestone | undefined {
	if (!milestone) {
		return undefined;
	}
	return {
		title: milestone.title,
		dueOn: milestone.dueOn,
		createdAt: milestone.createdAt,
		id: milestone.id
	};
}

export function parseMergeability(mergability: 'UNKNOWN' | 'MERGEABLE' | 'CONFLICTING'): PullRequestMergeability {
	switch (mergability) {
		case 'UNKNOWN': return PullRequestMergeability.Unknown;
		case 'MERGEABLE': return PullRequestMergeability.Mergeable;
		case 'CONFLICTING': return PullRequestMergeability.NotMergeable;
	}
}

export function parseGraphQLPullRequest(pullRequest: GraphQL.PullRequestResponse, githubRepository: GitHubRepository): PullRequest {
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
		head: parseRef(graphQLPullRequest.headRef),
		base: parseRef(graphQLPullRequest.baseRef),
		user: parseAuthor(graphQLPullRequest.author, githubRepository),
		merged: graphQLPullRequest.merged,
		mergeable: parseMergeability(graphQLPullRequest.mergeable),
		labels: graphQLPullRequest.labels.nodes,
		isDraft: graphQLPullRequest.isDraft,
		suggestedReviewers: parseSuggestedReviewers(graphQLPullRequest.suggestedReviewers)
	};
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
		user: parseAuthor(issue.author, githubRepository),
		labels: issue.labels.nodes
	};
}

export function parseGraphQLSearchRequest(pullRequest: GraphQL.PullRequest, githubRepository: GitHubRepository): PullRequest {
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
		head: parseRef(graphQLPullRequest.headRef),
		base: parseRef(graphQLPullRequest.baseRef),
		user: parseAuthor(graphQLPullRequest.author, githubRepository),
		merged: graphQLPullRequest.merged,
		mergeable: parseMergeability(graphQLPullRequest.mergeable),
		labels: graphQLPullRequest.labels.nodes,
		isDraft: graphQLPullRequest.isDraft,
		suggestedReviewers: parseSuggestedReviewers(graphQLPullRequest.suggestedReviewers),
		milestone: parseMilestone(graphQLPullRequest.milestone)
	};
}

function parseSuggestedReviewers(suggestedReviewers: GraphQL.SuggestedReviewerResponse[] | undefined): ISuggestedReviewer[] {
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
			isCommenter: suggestedReviewer.isCommenter
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

export function parseGraphQLReviewEvent(review: GraphQL.SubmittedReview, githubRepository: GitHubRepository): Common.ReviewEvent {
	return {
		event: Common.EventType.Reviewed,
		comments: review.comments.nodes.map(parseGraphQLComment).filter(c => !c.inReplyToId),
		submittedAt: review.submittedAt,
		body: review.body,
		bodyHTML: review.bodyHTML,
		htmlUrl: review.url,
		user: parseAuthor(review.author, githubRepository),
		authorAssociation: review.authorAssociation,
		state: review.state,
		id: review.databaseId
	};
}

export function parseGraphQLTimelineEvents(events: (GraphQL.MergedEvent | GraphQL.Review | GraphQL.IssueComment | GraphQL.Commit | GraphQL.AssignedEvent | GraphQL.HeadRefDeletedEvent)[], githubRepository: GitHubRepository): Common.TimelineEvent[] {
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
					createdAt: commentEvent.createdAt
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
					author: commitEv.commit.author.user ? parseAuthor(commitEv.commit.author.user, githubRepository) : { login: commitEv.commit.committer.name },
					htmlUrl: commitEv.url,
					message: commitEv.commit.message
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
					graphNodeId: mergeEv.id
				});
				return;
			case Common.EventType.Assigned:
				const assignEv = event as GraphQL.AssignedEvent;

				normalizedEvents.push({
					id: assignEv.databaseId,
					event: type,
					user: assignEv.user,
					actor: assignEv.actor
				});
				return;
			case Common.EventType.HeadRefDeleted:
				const deletedEv = event as GraphQL.HeadRefDeletedEvent;

				normalizedEvents.push({
					id: deletedEv.id,
					event: type,
					actor: deletedEv.actor,
					createdAt: deletedEv.createdAt,
					headRef: deletedEv.headRefName
				});
				return;
			default:
				break;
		}
	});

	return normalizedEvents;
}

export function parseGraphQLUser(user: GraphQL.UserResponse): User {
	return {
		login: user.user.login,
		name: user.user.name,
		avatarUrl: user.user.avatarUrl,
		url: user.user.url,
		bio: user.user.bio,
		company: user.user.company,
		location: user.user.location,
		commitContributions: parseGraphQLCommitContributions(user.user.contributionsCollection)
	};
}

function parseGraphQLCommitContributions(commitComments: GraphQL.ContributionsCollection): { createdAt: Date, repoNameWithOwner: string }[] {
	const items: { createdAt: Date, repoNameWithOwner: string }[] = [];
	commitComments.commitContributionsByRepository.forEach(repoCommits => {
		repoCommits.contributions.nodes.forEach(commit => {
			items.push({ createdAt: new Date(commit.occurredAt), repoNameWithOwner: repoCommits.repository.nameWithOwner });
		});
	});
	return items;
}

export function getReactionGroup(): { title: string; label: string; icon?: vscode.Uri }[] {
	const ret = [
		{
			title: 'CONFUSED',
			label: '😕',
			icon: Resource.icons.reactions.CONFUSED
		}, {
			title: 'EYES',
			label: '👀',
			icon: Resource.icons.reactions.EYES
		}, {
			title: 'HEART',
			label: '❤️',
			icon: Resource.icons.reactions.HEART
		}, {
			title: 'HOORAY',
			label: '🎉',
			icon: Resource.icons.reactions.HOORAY
		}, {
			title: 'LAUGH',
			label: '😄',
			icon: Resource.icons.reactions.LAUGH
		}, {
			title: 'ROCKET',
			label: '🚀',
			icon: Resource.icons.reactions.ROCKET
		}, {
			title: 'THUMBS_DOWN',
			label: '👎',
			icon: Resource.icons.reactions.THUMBS_DOWN
		}, {
			title: 'THUMBS_UP',
			label: '👍',
			icon: Resource.icons.reactions.THUMBS_UP
		}
	];

	return ret;
}

export function getRelatedUsersFromTimelineEvents(timelineEvents: Common.TimelineEvent[]): { login: string; name: string; }[] {
	const ret: { login: string; name: string; }[] = [];

	timelineEvents.forEach(event => {
		if (Common.isCommitEvent(event)) {
			ret.push({
				login: event.author.login,
				name: event.author.name || ''
			});
		}

		if (Common.isReviewEvent(event)) {
			ret.push({
				login: event.user.login,
				name: event.user.login
			});
		}

		if (Common.isCommentEvent(event)) {
			ret.push({
				login: event.user.login,
				name: event.user.login
			});
		}
	});

	return ret;
}
