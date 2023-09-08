/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as crypto from 'crypto';
import * as OctokitTypes from '@octokit/types';
import * as vscode from 'vscode';
import { Repository } from '../api/api';
import { GitApiImpl } from '../api/api1';
import { AuthProvider, GitHubServerType } from '../common/authentication';
import { IComment, IReviewThread, Reaction, SubjectType } from '../common/comment';
import { DiffHunk, parseDiffHunk } from '../common/diffHunk';
import { GitHubRef } from '../common/githubRef';
import Logger from '../common/logger';
import { Remote } from '../common/remote';
import { Resource } from '../common/resources';
import { GITHUB_ENTERPRISE, OVERRIDE_DEFAULT_BRANCH, PR_SETTINGS_NAMESPACE, URI } from '../common/settingKeys';
import * as Common from '../common/timelineEvent';
import { uniqBy } from '../common/utils';
import { OctokitCommon } from './common';
import { FolderRepositoryManager, PullRequestDefaults } from './folderRepositoryManager';
import { GitHubRepository, ViewerPermission } from './githubRepository';
import * as GraphQL from './graphql';
import {
	IAccount,
	IActor,
	IGitHubRef,
	ILabel,
	IMilestone,
	Issue,
	ISuggestedReviewer,
	ITeam,
	MergeMethod,
	PullRequest,
	PullRequestMergeability,
	reviewerId,
	reviewerLabel,
	ReviewState,
	User,
} from './interface';
import { IssueModel } from './issueModel';
import { GHPRComment, GHPRCommentThread } from './prComment';
import { PullRequestModel } from './pullRequestModel';

export const ISSUE_EXPRESSION = /(([A-Za-z0-9_.\-]+)\/([A-Za-z0-9_.\-]+))?(#|GH-)([1-9][0-9]*)($|\b)/;
export const ISSUE_OR_URL_EXPRESSION = /(https?:\/\/github\.com\/(([^\s]+)\/([^\s]+))\/([^\s]+\/)?(issues|pull)\/([0-9]+)(#issuecomment\-([0-9]+))?)|(([A-Za-z0-9_.\-]+)\/([A-Za-z0-9_.\-]+))?(#|GH-)([1-9][0-9]*)($|\b)/;

export interface CommentReactionHandler {
	toggleReaction(comment: vscode.Comment, reaction: vscode.CommentReaction): Promise<void>;
}

export type ParsedIssue = {
	owner: string | undefined;
	name: string | undefined;
	issueNumber: number;
	commentNumber?: number;
};

export function parseIssueExpressionOutput(output: RegExpMatchArray | null): ParsedIssue | undefined {
	if (!output) {
		return undefined;
	}
	const issue: ParsedIssue = { owner: undefined, name: undefined, issueNumber: 0 };
	if (output.length === 7) {
		issue.owner = output[2];
		issue.name = output[3];
		issue.issueNumber = parseInt(output[5]);
		return issue;
	} else if (output.length === 16) {
		issue.owner = output[3] || output[11];
		issue.name = output[4] || output[12];
		issue.issueNumber = parseInt(output[7] || output[14]);
		issue.commentNumber = output[9] !== undefined ? parseInt(output[9]) : undefined;
		return issue;
	} else {
		return undefined;
	}
}

export function threadRange(startLine: number, endLine: number, endCharacter?: number): vscode.Range {
	if ((startLine !== endLine) && (endCharacter === undefined)) {
		endCharacter = 300; // 300 is a "large" number that will select a lot of the line since don't know anything about the line length
	} else if (!endCharacter) {
		endCharacter = 0;
	}
	return new vscode.Range(startLine, 0, endLine, endCharacter);
}

export function createVSCodeCommentThreadForReviewThread(
	uri: vscode.Uri,
	range: vscode.Range | undefined,
	thread: IReviewThread,
	commentController: vscode.CommentController,
	currentUser: string,
	githubRepository?: GitHubRepository
): GHPRCommentThread {
	const vscodeThread = commentController.createCommentThread(uri, range, []);

	(vscodeThread as GHPRCommentThread).gitHubThreadId = thread.id;

	vscodeThread.comments = thread.comments.map(comment => new GHPRComment(comment, vscodeThread as GHPRCommentThread, githubRepository));
	vscodeThread.state = isResolvedToResolvedState(thread.isResolved);

	if (thread.viewerCanResolve && !thread.isResolved) {
		vscodeThread.contextValue = 'canResolve';
	} else if (thread.viewerCanUnresolve && thread.isResolved) {
		vscodeThread.contextValue = 'canUnresolve';
	}

	updateCommentThreadLabel(vscodeThread as GHPRCommentThread);
	vscodeThread.collapsibleState = getCommentCollapsibleState(thread, undefined, currentUser);

	return vscodeThread as GHPRCommentThread;
}

function isResolvedToResolvedState(isResolved: boolean) {
	return isResolved ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved;
}

export const COMMENT_EXPAND_STATE_SETTING = 'commentExpandState';
export const COMMENT_EXPAND_STATE_COLLAPSE_VALUE = 'collapseAll';
export const COMMENT_EXPAND_STATE_EXPAND_VALUE = 'expandUnresolved';
export function getCommentCollapsibleState(thread: IReviewThread, expand?: boolean, currentUser?: string) {
	if (thread.isResolved
		|| (currentUser && (thread.comments[thread.comments.length - 1].user?.login === currentUser) && thread.subjectType === SubjectType.LINE)) {
		return vscode.CommentThreadCollapsibleState.Collapsed;
	}
	if (expand === undefined) {
		const config = vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE)?.get(COMMENT_EXPAND_STATE_SETTING);
		expand = config === COMMENT_EXPAND_STATE_EXPAND_VALUE;
	}
	return expand
		? vscode.CommentThreadCollapsibleState.Expanded : vscode.CommentThreadCollapsibleState.Collapsed;
}


export function updateThreadWithRange(vscodeThread: GHPRCommentThread, reviewThread: IReviewThread, githubRepository: GitHubRepository, expand?: boolean) {
	if (!vscodeThread.range) {
		return;
	}
	const editors = vscode.window.visibleTextEditors;
	for (let editor of editors) {
		if (editor.document.uri.toString() === vscodeThread.uri.toString()) {
			const endLine = editor.document.lineAt(vscodeThread.range.end.line);
			const range = new vscode.Range(vscodeThread.range.start.line, 0, vscodeThread.range.end.line, endLine.text.length);
			updateThread(vscodeThread, reviewThread, githubRepository, expand, range);
			break;
		}
	}
}

export function updateThread(vscodeThread: GHPRCommentThread, reviewThread: IReviewThread, githubRepository: GitHubRepository, expand?: boolean, range?: vscode.Range) {
	if (reviewThread.viewerCanResolve && !reviewThread.isResolved) {
		vscodeThread.contextValue = 'canResolve';
	} else if (reviewThread.viewerCanUnresolve && reviewThread.isResolved) {
		vscodeThread.contextValue = 'canUnresolve';
	}

	const newResolvedState = isResolvedToResolvedState(reviewThread.isResolved);
	if (vscodeThread.state !== newResolvedState) {
		vscodeThread.state = newResolvedState;
	}
	vscodeThread.collapsibleState = getCommentCollapsibleState(reviewThread, expand);
	if (range) {
		vscodeThread.range = range;
	}
	if ((vscodeThread.comments.length === reviewThread.comments.length) && vscodeThread.comments.every((vscodeComment, index) => vscodeComment.commentId === `${reviewThread.comments[index].id}`)) {
		// The comments all still exist. Update them instead of creating new ones. This allows the UI to be more stable.
		let index = 0;
		for (const comment of vscodeThread.comments) {
			if (comment instanceof GHPRComment) {
				comment.update(reviewThread.comments[index]);
			}
			index++;
		}
	} else {
		vscodeThread.comments = reviewThread.comments.map(c => new GHPRComment(c, vscodeThread, githubRepository));
	}
	updateCommentThreadLabel(vscodeThread);
}

export function updateCommentThreadLabel(thread: GHPRCommentThread) {
	if (thread.state === vscode.CommentThreadState.Resolved) {
		thread.label = vscode.l10n.t('Marked as resolved');
		return;
	}

	if (thread.comments.length) {
		const participantsList = uniqBy(thread.comments as vscode.Comment[], comment => comment.author.name)
			.map(comment => `@${comment.author.name}`)
			.join(', ');
		thread.label = vscode.l10n.t('Participants: {0}', participantsList);
	} else {
		thread.label = vscode.l10n.t('Start discussion');
	}
}

export function updateCommentReactions(comment: vscode.Comment, reactions: Reaction[] | undefined) {
	let reactionsHaveUpdates = false;
	const previousReactions = comment.reactions;
	const newReactions = getReactionGroup().map((reaction, index) => {
		if (!reactions) {
			return { label: reaction.label, authorHasReacted: false, count: 0, iconPath: reaction.icon || '' };
		}

		const matchedReaction = reactions.find(re => re.label === reaction.label);
		let newReaction: vscode.CommentReaction;
		if (matchedReaction) {
			newReaction = {
				label: matchedReaction.label,
				authorHasReacted: matchedReaction.viewerHasReacted,
				count: matchedReaction.count,
				iconPath: reaction.icon || '',
			};
		} else {
			newReaction = { label: reaction.label, authorHasReacted: false, count: 0, iconPath: reaction.icon || '' };
		}
		if (!reactionsHaveUpdates && (!previousReactions || (previousReactions[index].authorHasReacted !== newReaction.authorHasReacted) || (previousReactions[index].count !== newReaction.count))) {
			reactionsHaveUpdates = true;
		}
		return newReaction;
	});
	comment.reactions = newReactions;
	return reactionsHaveUpdates;
}

export function updateCommentReviewState(thread: GHPRCommentThread, newDraftMode: boolean) {
	if (newDraftMode) {
		return;
	}

	thread.comments = thread.comments.map(comment => {
		if (comment instanceof GHPRComment) {
			comment.rawComment.isDraft = false;
		}

		comment.label = undefined;

		return comment;
	});
}

export function isEnterprise(provider: AuthProvider): boolean {
	return provider === AuthProvider.githubEnterprise;
}

export function convertRESTUserToAccount(
	user: OctokitCommon.PullsListResponseItemUser,
	githubRepository?: GitHubRepository,
): IAccount {
	return {
		login: user.login,
		url: user.html_url,
		avatarUrl: githubRepository ? getAvatarWithEnterpriseFallback(user.avatar_url, user.gravatar_id ?? undefined, githubRepository.remote.isEnterprise) : user.avatar_url,
		id: user.node_id
	};
}

export function convertRESTHeadToIGitHubRef(head: OctokitCommon.PullsListResponseItemHead): IGitHubRef {
	return {
		label: head.label,
		ref: head.ref,
		sha: head.sha,
		repo: {
			cloneUrl: head.repo.clone_url,
			isInOrganization: !!head.repo.organization,
			owner: head.repo.owner!.login,
			name: head.repo.name
		},
	};
}

export function convertRESTPullRequestToRawPullRequest(
	pullRequest:
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
		titleHTML: title,
		url: html_url,
		user: convertRESTUserToAccount(user!, githubRepository),
		state,
		merged: (pullRequest as OctokitCommon.PullsGetResponseData).merged || false,
		assignees: assignees
			? assignees.map(assignee => convertRESTUserToAccount(assignee!, githubRepository))
			: undefined,
		createdAt: created_at,
		updatedAt: updated_at,
		head: head.repo ? convertRESTHeadToIGitHubRef(head as OctokitCommon.PullsListResponseItemHead) : undefined,
		base: convertRESTHeadToIGitHubRef(base),
		labels: labels.map<ILabel>(l => ({ name: '', color: '', ...l })),
		isDraft: draft,
		suggestedReviewers: [], // suggested reviewers only available through GraphQL API
	};

	// mergeable is not included in the list response, will need to fetch later
	if ('mergeable' in pullRequest) {
		item.mergeable = pullRequest.mergeable
			? PullRequestMergeability.Mergeable
			: PullRequestMergeability.NotMergeable;
	}

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
		titleHTML: title,
		url: html_url,
		user: convertRESTUserToAccount(user!, githubRepository),
		state,
		assignees: assignees
			? assignees.map(assignee => convertRESTUserToAccount(assignee!, githubRepository))
			: undefined,
		createdAt: created_at,
		updatedAt: updated_at,
		labels: labels.map<ILabel>(l =>
			typeof l === 'string' ? { name: l, color: '' } : { name: l.name ?? '', color: l.color ?? '', description: l.description ?? undefined },
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

export function parseGraphQLReviewThread(thread: GraphQL.ReviewThread, githubRepository: GitHubRepository): IReviewThread {
	return {
		id: thread.id,
		prReviewDatabaseId: thread.comments.edges && thread.comments.edges.length ?
			thread.comments.edges[0].node.pullRequestReview.databaseId :
			undefined,
		isResolved: thread.isResolved,
		viewerCanResolve: thread.viewerCanResolve,
		viewerCanUnresolve: thread.viewerCanUnresolve,
		path: thread.path,
		startLine: thread.startLine ?? thread.line,
		endLine: thread.line,
		originalStartLine: thread.originalStartLine ?? thread.originalLine,
		originalEndLine: thread.originalLine,
		diffSide: thread.diffSide,
		isOutdated: thread.isOutdated,
		comments: thread.comments.nodes.map(comment => parseGraphQLComment(comment, thread.isResolved, githubRepository)),
		subjectType: thread.subjectType ?? SubjectType.LINE
	};
}

export function parseGraphQLComment(comment: GraphQL.ReviewComment, isResolved: boolean, githubRepository: GitHubRepository): IComment {
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
		user: comment.author ? parseAuthor(comment.author, githubRepository) : undefined,
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

export function parseGraphQlIssueComment(comment: GraphQL.IssueComment, githubRepository: GitHubRepository): IComment {
	return {
		id: comment.databaseId,
		url: comment.url,
		body: comment.body,
		bodyHTML: comment.bodyHTML,
		canEdit: comment.viewerCanDelete,
		canDelete: comment.viewerCanDelete,
		user: parseAuthor(comment.author, githubRepository),
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
			isInOrganization: repository.isInOrganization,
			owner: repository.owner.login,
			name: refName
		},
	};
}

function parseAuthor(
	author: { login: string; url: string; avatarUrl: string; email?: string, id: string } | null,
	githubRepository: GitHubRepository,
): IAccount {
	if (author) {
		return {
			login: author.login,
			url: author.url,
			avatarUrl: getAvatarWithEnterpriseFallback(author.avatarUrl, undefined, githubRepository.remote.isEnterprise),
			email: author.email,
			id: author.id
		};
	} else {
		return {
			login: '',
			url: '',
			id: ''
		};
	}
}

function parseActor(
	author: { login: string; url: string; avatarUrl: string; } | null,
	githubRepository: GitHubRepository,
): IActor {
	if (author) {
		return {
			login: author.login,
			url: author.url,
			avatarUrl: getAvatarWithEnterpriseFallback(author.avatarUrl, undefined, githubRepository.remote.isEnterprise),
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

function parseMergeMethod(mergeMethod: 'MERGE' | 'SQUASH' | 'REBASE' | undefined): MergeMethod | undefined {
	switch (mergeMethod) {
		case 'MERGE': return 'merge';
		case 'REBASE': return 'rebase';
		case 'SQUASH': return 'squash';
	}
}

export function parseMergeability(mergeability: 'UNKNOWN' | 'MERGEABLE' | 'CONFLICTING',
	mergeStateStatus: 'BEHIND' | 'BLOCKED' | 'CLEAN' | 'DIRTY' | 'HAS_HOOKS' | 'UNKNOWN' | 'UNSTABLE'): PullRequestMergeability {
	let parsed: PullRequestMergeability;
	switch (mergeability) {
		case 'UNKNOWN':
			parsed = PullRequestMergeability.Unknown;
			break;
		case 'MERGEABLE':
			parsed = PullRequestMergeability.Mergeable;
			break;
		case 'CONFLICTING':
			parsed = PullRequestMergeability.Conflict;
			break;
	}
	if (parsed !== PullRequestMergeability.Conflict) {
		if (mergeStateStatus === 'BLOCKED') {
			parsed = PullRequestMergeability.NotMergeable;
		} else if (mergeStateStatus === 'BEHIND') {
			parsed = PullRequestMergeability.Behind;
		}
	}
	return parsed;
}

export function parseGraphQLPullRequest(
	graphQLPullRequest: GraphQL.PullRequest,
	githubRepository: GitHubRepository,
): PullRequest {
	return {
		id: graphQLPullRequest.databaseId,
		graphNodeId: graphQLPullRequest.id,
		url: graphQLPullRequest.url,
		number: graphQLPullRequest.number,
		state: graphQLPullRequest.state,
		body: graphQLPullRequest.body,
		bodyHTML: graphQLPullRequest.bodyHTML,
		title: graphQLPullRequest.title,
		titleHTML: graphQLPullRequest.titleHTML,
		createdAt: graphQLPullRequest.createdAt,
		updatedAt: graphQLPullRequest.updatedAt,
		isRemoteHeadDeleted: !graphQLPullRequest.headRef,
		head: parseRef(graphQLPullRequest.headRef?.name ?? graphQLPullRequest.headRefName, graphQLPullRequest.headRefOid, graphQLPullRequest.headRepository),
		isRemoteBaseDeleted: !graphQLPullRequest.baseRef,
		base: parseRef(graphQLPullRequest.baseRef?.name ?? graphQLPullRequest.baseRefName, graphQLPullRequest.baseRefOid, graphQLPullRequest.baseRepository),
		user: parseAuthor(graphQLPullRequest.author, githubRepository),
		merged: graphQLPullRequest.merged,
		mergeable: parseMergeability(graphQLPullRequest.mergeable, graphQLPullRequest.mergeStateStatus),
		autoMerge: !!graphQLPullRequest.autoMergeRequest,
		autoMergeMethod: parseMergeMethod(graphQLPullRequest.autoMergeRequest?.mergeMethod),
		allowAutoMerge: graphQLPullRequest.viewerCanEnableAutoMerge || graphQLPullRequest.viewerCanDisableAutoMerge,
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
		titleHTML: issue.titleHTML,
		createdAt: issue.createdAt,
		updatedAt: issue.updatedAt,
		assignees: issue.assignees?.nodes.map(assignee => parseAuthor(assignee, githubRepository)),
		user: parseAuthor(issue.author, githubRepository),
		labels: issue.labels.nodes,
		repositoryName: issue.repository?.name ?? githubRepository.remote.repositoryName,
		repositoryOwner: issue.repository?.owner.login ?? githubRepository.remote.owner,
		repositoryUrl: issue.repository?.url ?? githubRepository.remote.url,
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
			id: suggestedReviewer.reviewer.id
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
/**
 * Used for case insensitive sort by team name
 */
export function teamComparator(a: ITeam, b: ITeam) {
	const aKey = a.name ?? a.slug;
	const bKey = b.name ?? b.slug;
	// sensitivity: 'accent' allows case insensitive comparison
	return aKey.localeCompare(bKey, 'en', { sensitivity: 'accent' });
}

export function parseGraphQLReviewEvent(
	review: GraphQL.SubmittedReview,
	githubRepository: GitHubRepository,
): Common.ReviewEvent {
	return {
		event: Common.EventType.Reviewed,
		comments: review.comments.nodes.map(comment => parseGraphQLComment(comment, false, githubRepository)).filter(c => !c.inReplyToId),
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
					id: commitEv.id,
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
					id: mergeEv.id,
					event: type,
					user: parseActor(mergeEv.actor, githubRepository),
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
					id: assignEv.id,
					event: type,
					user: parseAuthor(assignEv.user, githubRepository),
					actor: assignEv.actor,
				});
				return;
			case Common.EventType.HeadRefDeleted:
				const deletedEv = event as GraphQL.HeadRefDeletedEvent;

				normalizedEvents.push({
					id: deletedEv.id,
					event: type,
					actor: parseActor(deletedEv.actor, githubRepository),
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
		avatarUrl: getAvatarWithEnterpriseFallback(user.user.avatarUrl ?? '', undefined, githubRepository.remote.isEnterprise),
		url: user.user.url,
		bio: user.user.bio,
		company: user.user.company,
		location: user.user.location,
		commitContributions: parseGraphQLCommitContributions(user.user.contributionsCollection),
		id: user.user.id
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
			// allow-any-unicode-next-line
			label: '👍',
			icon: Resource.icons.reactions.THUMBS_UP,
		},
		{
			title: 'THUMBS_DOWN',
			// allow-any-unicode-next-line
			label: '👎',
			icon: Resource.icons.reactions.THUMBS_DOWN,
		},
		{
			title: 'LAUGH',
			// allow-any-unicode-next-line
			label: '😄',
			icon: Resource.icons.reactions.LAUGH,
		},
		{
			title: 'HOORAY',
			// allow-any-unicode-next-line
			label: '🎉',
			icon: Resource.icons.reactions.HOORAY,
		},
		{
			title: 'CONFUSED',
			// allow-any-unicode-next-line
			label: '😕',
			icon: Resource.icons.reactions.CONFUSED,
		},
		{
			title: 'HEART',
			// allow-any-unicode-next-line
			label: '❤️',
			icon: Resource.icons.reactions.HEART,
		},
		{
			title: 'ROCKET',
			// allow-any-unicode-next-line
			label: '🚀',
			icon: Resource.icons.reactions.ROCKET,
		},
		{
			title: 'EYES',
			// allow-any-unicode-next-line
			label: '👀',
			icon: Resource.icons.reactions.EYES,
		},
	];

	return ret;
}

export async function restPaginate<R extends OctokitTypes.RequestInterface, T>(request: R, variables: Parameters<R>[0]): Promise<T[]> {
	let page = 1;
	let results: T[] = [];
	let hasNextPage = false;

	do {
		const result = await request(
			{
				...(variables as any),
				per_page: 100,
				page
			}
		);

		results = results.concat(
			result.data as T[]
		);

		hasNextPage = !!result.headers.link && result.headers.link.indexOf('rel="next"') > -1;
		page += 1;
	} while (hasNextPage);

	return results;
}

export function getRelatedUsersFromTimelineEvents(
	timelineEvents: Common.TimelineEvent[],
): { login: string; name: string }[] {
	const ret: { login: string; name: string }[] = [];

	timelineEvents.forEach(event => {
		if (event.event === Common.EventType.Committed) {
			ret.push({
				login: event.author.login,
				name: event.author.name || '',
			});
		}

		if (event.event === Common.EventType.Reviewed) {
			ret.push({
				login: event.user.login,
				name: event.user.name ?? event.user.login,
			});
		}

		if (event.event === Common.EventType.Commented) {
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

export function isFileInRepo(repository: Repository, file: vscode.Uri): boolean {
	return file.path.toLowerCase() === repository.rootUri.path.toLowerCase() ||
		(file.path.toLowerCase().startsWith(repository.rootUri.path.toLowerCase()) &&
			file.path.substring(repository.rootUri.path.length).startsWith('/'));
}

export function getRepositoryForFile(gitAPI: GitApiImpl, file: vscode.Uri): Repository | undefined {
	for (const repository of gitAPI.repositories) {
		if (isFileInRepo(repository, file)) {
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
	requestedReviewers: (IAccount | ITeam)[],
	timelineEvents: Common.TimelineEvent[],
	author: IAccount,
): ReviewState[] {
	const reviewEvents = timelineEvents.filter((e): e is Common.ReviewEvent => e.event === Common.EventType.Reviewed).filter(event => event.state !== 'PENDING');
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
		if (!seen.get(reviewerId(request))) {
			reviewers.push({
				reviewer: request,
				state: 'REQUESTED',
			});
		} else {
			const reviewer = reviewers.find(r => reviewerId(r.reviewer) === reviewerId(request));
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

		return reviewerLabel(a.reviewer).toLowerCase() < reviewerLabel(b.reviewer).toLowerCase() ? -1 : 1;
	});

	return reviewers;
}

export function insertNewCommitsSinceReview(
	timelineEvents: Common.TimelineEvent[],
	latestReviewCommitOid: string | undefined,
	currentUser: string,
	head: GitHubRef | null
) {
	if (latestReviewCommitOid && head && head.sha !== latestReviewCommitOid) {
		let lastViewerReviewIndex: number = timelineEvents.length - 1;
		let comittedDuringReview: boolean = false;
		let interReviewCommits: Common.TimelineEvent[] = [];

		for (let i = timelineEvents.length - 1; i > 0; i--) {
			if (
				timelineEvents[i].event === Common.EventType.Committed &&
				(timelineEvents[i] as Common.CommitEvent).sha === latestReviewCommitOid
			) {
				interReviewCommits.unshift({
					id: latestReviewCommitOid,
					event: Common.EventType.NewCommitsSinceReview
				});
				timelineEvents.splice(lastViewerReviewIndex + 1, 0, ...interReviewCommits);
				break;
			}
			else if (comittedDuringReview && timelineEvents[i].event === Common.EventType.Committed) {
				interReviewCommits.unshift(timelineEvents[i]);
				timelineEvents.splice(i, 1);
			}
			else if (
				!comittedDuringReview &&
				timelineEvents[i].event === Common.EventType.Reviewed &&
				(timelineEvents[i] as Common.ReviewEvent).user.login === currentUser
			) {
				lastViewerReviewIndex = i;
				comittedDuringReview = true;
			}
		}
	}
}

export function getPRFetchQuery(repo: string, user: string, query: string): string {
	const filter = query.replace(/\$\{user\}/g, user);
	return `is:pull-request ${filter} type:pr repo:${repo}`;
}

export function isInCodespaces(): boolean {
	return vscode.env.remoteName === 'codespaces' && vscode.env.uiKind === vscode.UIKind.Web;
}

export async function setEnterpriseUri(host: string) {
	return vscode.workspace.getConfiguration(GITHUB_ENTERPRISE).update(URI, host, vscode.ConfigurationTarget.Workspace);
}

export function getEnterpriseUri(): vscode.Uri | undefined {
	const config: string = vscode.workspace.getConfiguration(GITHUB_ENTERPRISE).get<string>(URI, '');
	if (config) {
		let uri = vscode.Uri.parse(config, true);
		if (uri.scheme === 'http') {
			uri = uri.with({ scheme: 'https' });
		}
		return uri;
	}
}

export function hasEnterpriseUri(): boolean {
	return !!getEnterpriseUri();
}

export function generateGravatarUrl(gravatarId: string | undefined, size: number = 200): string | undefined {
	return !!gravatarId ? `https://www.gravatar.com/avatar/${gravatarId}?s=${size}&d=retro` : undefined;
}

export function getAvatarWithEnterpriseFallback(avatarUrl: string, email: string | undefined, isEnterpriseRemote: boolean): string | undefined {
	return !isEnterpriseRemote ? avatarUrl : (email ? generateGravatarUrl(
		crypto.createHash('md5').update(email?.trim()?.toLowerCase()).digest('hex')) : undefined);
}

export function getPullsUrl(repo: GitHubRepository) {
	return vscode.Uri.parse(`https://${repo.remote.host}/${repo.remote.owner}/${repo.remote.repositoryName}/pulls`);
}

export function getIssuesUrl(repo: GitHubRepository) {
	return vscode.Uri.parse(`https://${repo.remote.host}/${repo.remote.owner}/${repo.remote.repositoryName}/issues`);
}

export function sanitizeIssueTitle(title: string): string {
	const regex = /[~^:;'".,~#?%*[\]@\\{}()/]|\/\//g;

	return title.replace(regex, '').trim().substring(0, 150).replace(/\s+/g, '-');
}

const VARIABLE_PATTERN = /\$\{(.*?)\}/g;
export async function variableSubstitution(
	value: string,
	issueModel?: IssueModel,
	defaults?: PullRequestDefaults,
	user?: string,
): Promise<string> {
	return value.replace(VARIABLE_PATTERN, (match: string, variable: string) => {
		switch (variable) {
			case 'user':
				return user ? user : match;
			case 'issueNumber':
				return issueModel ? `${issueModel.number}` : match;
			case 'issueNumberLabel':
				return issueModel ? `${getIssueNumberLabel(issueModel, defaults)}` : match;
			case 'issueTitle':
				return issueModel ? issueModel.title : match;
			case 'repository':
				return defaults ? defaults.repo : match;
			case 'owner':
				return defaults ? defaults.owner : match;
			case 'sanitizedIssueTitle':
				return issueModel ? sanitizeIssueTitle(issueModel.title) : match; // check what characters are permitted
			case 'sanitizedLowercaseIssueTitle':
				return issueModel ? sanitizeIssueTitle(issueModel.title).toLowerCase() : match;
			default:
				return match;
		}
	});
}

export function getIssueNumberLabel(issue: IssueModel, repo?: PullRequestDefaults) {
	const parsedIssue: ParsedIssue = { issueNumber: issue.number, owner: undefined, name: undefined };
	if (
		repo &&
		(repo.owner.toLowerCase() !== issue.remote.owner.toLowerCase() ||
			repo.repo.toLowerCase() !== issue.remote.repositoryName.toLowerCase())
	) {
		parsedIssue.owner = issue.remote.owner;
		parsedIssue.name = issue.remote.repositoryName;
	}
	return getIssueNumberLabelFromParsed(parsedIssue);
}

export function getIssueNumberLabelFromParsed(parsed: ParsedIssue) {
	if (!parsed.owner || !parsed.name) {
		return `#${parsed.issueNumber}`;
	} else {
		return `${parsed.owner}/${parsed.name}#${parsed.issueNumber}`;
	}
}

export function getOverrideBranch(): string | undefined {
	const overrideSetting = vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE).get<string | undefined>(OVERRIDE_DEFAULT_BRANCH);
	if (overrideSetting) {
		Logger.debug('Using override setting for default branch', GitHubRepository.ID);
		return overrideSetting;
	}
}

export async function findDotComAndEnterpriseRemotes(folderManagers: FolderRepositoryManager[]): Promise<{ dotComRemotes: Remote[], enterpriseRemotes: Remote[], unknownRemotes: Remote[] }> {
	// Check if we have found any github.com remotes
	const dotComRemotes: Remote[] = [];
	const enterpriseRemotes: Remote[] = [];
	const unknownRemotes: Remote[] = [];
	for (const manager of folderManagers) {
		for (const remote of await manager.computeAllGitHubRemotes()) {
			if (remote.githubServerType === GitHubServerType.GitHubDotCom) {
				dotComRemotes.push(remote);
			} else if (remote.githubServerType === GitHubServerType.Enterprise) {
				enterpriseRemotes.push(remote);
			}
		}
		unknownRemotes.push(...await manager.computeAllUnknownRemotes());
	}
	return { dotComRemotes, enterpriseRemotes, unknownRemotes };
}

export function vscodeDevPrLink(pullRequest: PullRequestModel) {
	const itemUri = vscode.Uri.parse(pullRequest.html_url);
	return `https://${vscode.env.appName.toLowerCase().includes('insider') ? 'insiders.' : ''}vscode.dev/github${itemUri.path}`;
}
