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
import { COPILOT_ACCOUNTS, IComment, IReviewThread, SubjectType } from '../common/comment';
import { DiffHunk, parseDiffHunk } from '../common/diffHunk';
import { GitHubRef } from '../common/githubRef';
import Logger from '../common/logger';
import { Remote } from '../common/remote';
import { Resource } from '../common/resources';
import { GITHUB_ENTERPRISE, OVERRIDE_DEFAULT_BRANCH, PR_SETTINGS_NAMESPACE, URI } from '../common/settingKeys';
import * as Common from '../common/timelineEvent';
import { DataUri, toOpenIssueWebviewUri, toOpenPullRequestWebviewUri } from '../common/uri';
import { escapeRegExp, gitHubLabelColor, stringReplaceAsync, uniqBy } from '../common/utils';
import { OctokitCommon } from './common';
import { FolderRepositoryManager, PullRequestDefaults } from './folderRepositoryManager';
import { GitHubRepository, ViewerPermission } from './githubRepository';
import * as GraphQL from './graphql';
import {
	AccountType,
	IAccount,
	IActor,
	IGitHubRef,
	IIssueComment,
	ILabel,
	IMilestone,
	IProjectItem,
	Issue,
	ISuggestedReviewer,
	ITeam,
	MergeMethod,
	MergeQueueEntry,
	MergeQueueState,
	Notification,
	NotificationSubjectType,
	PullRequest,
	PullRequestMergeability,
	Reaction,
	reviewerId,
	reviewerLabel,
	ReviewState,
	toAccountType,
	User,
} from './interface';
import { IssueModel } from './issueModel';
import { GHPRComment, GHPRCommentThread } from './prComment';

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

export async function setReplyAuthor(thread: vscode.CommentThread | vscode.CommentThread2, currentUser: IAccount, context: vscode.ExtensionContext) {
	if (currentUser.avatarUrl) {
		const thread2 = thread as vscode.CommentThread2;
		thread2.canReply = { name: currentUser.name ?? currentUser.login, iconPath: vscode.Uri.parse(currentUser.avatarUrl) };
		const uri = await DataUri.avatarCirclesAsImageDataUris(context, [currentUser], 28, 28);
		thread2.canReply = { name: currentUser.name ?? currentUser.login, iconPath: uri[0] };
	} else {
		thread.canReply = true;
	}
}

export function createVSCodeCommentThreadForReviewThread(
	context: vscode.ExtensionContext,
	uri: vscode.Uri,
	range: vscode.Range | undefined,
	thread: IReviewThread,
	commentController: vscode.CommentController,
	currentUser: IAccount,
	githubRepositories?: GitHubRepository[]
): GHPRCommentThread {
	const vscodeThread = commentController.createCommentThread(uri, range, []);

	(vscodeThread as GHPRCommentThread).gitHubThreadId = thread.id;

	vscodeThread.comments = thread.comments.map(comment => new GHPRComment(context, comment, vscodeThread as GHPRCommentThread, githubRepositories));
	const resolved = isResolvedToResolvedState(thread.isResolved);
	let applicability = vscode.CommentThreadApplicability.Current;

	if (thread.viewerCanResolve && !thread.isResolved) {
		vscodeThread.contextValue = 'canResolve';
	} else if (thread.viewerCanUnresolve && thread.isResolved) {
		vscodeThread.contextValue = 'canUnresolve';
	}
	if (thread.isOutdated) {
		vscodeThread.contextValue += 'outdated';
		applicability = vscode.CommentThreadApplicability.Outdated;
	}
	vscodeThread.state = { resolved, applicability };

	updateCommentThreadLabel(vscodeThread as GHPRCommentThread);
	vscodeThread.collapsibleState = getCommentCollapsibleState(thread, undefined, currentUser.login);

	setReplyAuthor(vscodeThread, currentUser, context);

	return vscodeThread as GHPRCommentThread;
}

function isResolvedToResolvedState(isResolved: boolean) {
	return isResolved ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved;
}

export const COMMENT_EXPAND_STATE_SETTING = 'commentExpandState';
export const COMMENT_EXPAND_STATE_COLLAPSE_VALUE = 'collapseAll';
export const COMMENT_EXPAND_STATE_EXPAND_VALUE = 'expandUnresolved';
export function getCommentCollapsibleState(thread: IReviewThread, expand?: boolean, currentUser?: string) {
	const isFromCurrent = (currentUser && (thread.comments[thread.comments.length - 1].user?.login === currentUser));
	const isJustSuggestion = thread.comments.length === 1 && thread.comments[0].body.startsWith('```suggestion') && thread.comments[0].body.endsWith('```');
	if (thread.isResolved || (!thread.isOutdated && isFromCurrent && !isJustSuggestion)) {
		return vscode.CommentThreadCollapsibleState.Collapsed;
	}
	if (expand === undefined) {
		const config = vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE)?.get(COMMENT_EXPAND_STATE_SETTING);
		expand = config === COMMENT_EXPAND_STATE_EXPAND_VALUE;
	}
	return expand
		? vscode.CommentThreadCollapsibleState.Expanded : vscode.CommentThreadCollapsibleState.Collapsed;
}


export function updateThreadWithRange(context: vscode.ExtensionContext, vscodeThread: GHPRCommentThread, reviewThread: IReviewThread, githubRepositories?: GitHubRepository[], expand?: boolean) {
	if (!vscodeThread.range) {
		return;
	}
	const editors = vscode.window.visibleTextEditors;
	for (let editor of editors) {
		if (editor.document.uri.toString() === vscodeThread.uri.toString()) {
			const endLine = editor.document.lineAt(vscodeThread.range.end.line);
			const range = new vscode.Range(vscodeThread.range.start.line, 0, vscodeThread.range.end.line, endLine.text.length);
			updateThread(context, vscodeThread, reviewThread, githubRepositories, expand, range);
			break;
		}
	}
}

export function updateThread(context: vscode.ExtensionContext, vscodeThread: GHPRCommentThread, reviewThread: IReviewThread, githubRepositories?: GitHubRepository[], expand?: boolean, range?: vscode.Range) {
	if (reviewThread.viewerCanResolve && !reviewThread.isResolved) {
		vscodeThread.contextValue = 'canResolve';
	} else if (reviewThread.viewerCanUnresolve && reviewThread.isResolved) {
		vscodeThread.contextValue = 'canUnresolve';
	}

	if (reviewThread.isOutdated) {
		vscodeThread.contextValue += 'outdated';
	}

	const newResolvedState = isResolvedToResolvedState(reviewThread.isResolved);
	const newApplicabilityState = reviewThread.isOutdated ? vscode.CommentThreadApplicability.Outdated : vscode.CommentThreadApplicability.Current;
	if ((vscodeThread.state?.resolved !== newResolvedState) || (vscodeThread.state?.applicability !== newApplicabilityState)) {
		vscodeThread.state = {
			resolved: newResolvedState,
			applicability: newApplicabilityState
		};
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
		vscodeThread.comments = reviewThread.comments.map(c => new GHPRComment(context, c, vscodeThread, githubRepositories));
	}

	updateCommentThreadLabel(vscodeThread);
}

export function updateCommentThreadLabel(thread: GHPRCommentThread) {
	if (thread.state?.resolved === vscode.CommentThreadState.Resolved) {
		thread.label = vscode.l10n.t('Marked as resolved');
		return;
	}

	if (thread.comments.length) {
		const participantsList = uniqBy(thread.comments, comment => comment.originalAuthor.name)
			.map(comment => `@${comment.originalAuthor.name}`)
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
				reactors: matchedReaction.reactors.map(reactor => ({ name: reactor }))
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
	return parseAccount(user, githubRepository);
}

export function convertRESTHeadToIGitHubRef(head: OctokitCommon.PullsListResponseItemHead): IGitHubRef {
	return {
		label: head.label,
		ref: head.ref,
		sha: head.sha,
		repo: {
			cloneUrl: head.repo.clone_url,
			isInOrganization: head.repo.owner.type === 'Organization',
			owner: head.repo.owner!.login,
			name: head.repo.name
		},
	};
}

async function transformHtmlUrlsToExtensionUrls(body: string, githubRepository: GitHubRepository): Promise<string> {
	const issueRegex = new RegExp(
		`href="https?:\/\/${escapeRegExp(githubRepository.remote.gitProtocol.url.authority)}\\/${escapeRegExp(githubRepository.remote.owner)}\\/${escapeRegExp(githubRepository.remote.repositoryName)}\\/(issues|pull)\\/([0-9]+)"`);
	return stringReplaceAsync(body, issueRegex, async (match: string, issuesOrPull: string, number: string) => {
		if (issuesOrPull === 'issues') {
			return `href="${(await toOpenIssueWebviewUri({ owner: githubRepository.remote.owner, repo: githubRepository.remote.repositoryName, issueNumber: Number(number) })).toString()}""`;
		} else {
			return `href="${(await toOpenPullRequestWebviewUri({ owner: githubRepository.remote.owner, repo: githubRepository.remote.repositoryName, pullRequestNumber: Number(number) })).toString()}"`;
		}
	});
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
		viewerCanUpdate: false,
		head: head.repo ? convertRESTHeadToIGitHubRef(head as OctokitCommon.PullsListResponseItemHead) : undefined,
		base: convertRESTHeadToIGitHubRef(base),
		labels: labels.map<ILabel>(l => ({ name: '', color: '', ...l })),
		isDraft: draft,
		suggestedReviewers: [], // suggested reviewers only available through GraphQL API
		projectItems: [], // projects only available through GraphQL API
		commits: [], // commits only available through GraphQL API
		reactionCount: 0, // reaction count only available through GraphQL API
		reactions: [], // reactions only available through GraphQL API
		commentCount: 0 // comment count only available through GraphQL API
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
): Issue {
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
		comments
	} = pullRequest;

	const item: Issue = {
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
		projectItems: [], // projects only available through GraphQL API
		reactionCount: 0, // reaction count only available through GraphQL API
		reactions: [], // reactions only available through GraphQL API
		commentCount: comments
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
		reactions: undefined // reactions only available through GraphQL API
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
		case 'UnassignedEvent':
			return Common.EventType.Unassigned;
		case 'HeadRefDeletedEvent':
			return Common.EventType.HeadRefDeleted;
		case 'IssueComment':
			return Common.EventType.Commented;
		case 'PullRequestReview':
			return Common.EventType.Reviewed;
		case 'MergedEvent':
			return Common.EventType.Merged;
		case 'CrossReferencedEvent':
			return Common.EventType.CrossReferenced;
		case 'ClosedEvent':
			return Common.EventType.Closed;
		case 'ReopenedEvent':
			return Common.EventType.Reopened;
		default:
			return Common.EventType.Other;
	}
}

export function parseGraphQLReviewThread(thread: GraphQL.ReviewThread, githubRepository: GitHubRepository): IReviewThread {
	return {
		id: thread.id,
		prReviewDatabaseId: thread.comments.edges && thread.comments.edges.length ?
			thread.comments.edges[0].node.pullRequestReview?.databaseId :
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
	const specialAuthor = COPILOT_ACCOUNTS[comment.author?.login ?? ''];
	const c: IComment = {
		id: comment.databaseId,
		url: comment.url,
		body: comment.body,
		specialDisplayBodyPostfix: specialAuthor?.postComment,
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
		user: comment.author ? parseAccount(comment.author, githubRepository) : undefined,
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
		specialDisplayBodyPostfix: COPILOT_ACCOUNTS[comment.author?.login ?? '']?.postComment,
		bodyHTML: comment.bodyHTML,
		canEdit: comment.viewerCanDelete,
		canDelete: comment.viewerCanDelete,
		user: parseAccount(comment.author, githubRepository),
		createdAt: comment.createdAt,
		htmlUrl: comment.url,
		graphNodeId: comment.id,
		diffHunk: '',
		reactions: parseGraphQLReaction(comment.reactionGroups),
	};
}

export function parseGraphQLReaction(reactionGroups: GraphQL.ReactionGroup[]): Reaction[] {
	const reactionContentEmojiMapping = getReactionGroup().reduce((prev, curr) => {
		prev[curr.title] = curr;
		return prev;
	}, {} as { [key: string]: { title: string; label: string; icon?: vscode.Uri } });

	const reactions = reactionGroups
		.filter(group => group.reactors.totalCount > 0)
		.map(group => {
			const reaction: Reaction = {
				label: reactionContentEmojiMapping[group.content].label,
				count: group.reactors.totalCount,
				icon: reactionContentEmojiMapping[group.content].icon,
				viewerHasReacted: group.viewerHasReacted,
				reactors: group.reactors.nodes.map(node => COPILOT_ACCOUNTS[node.login]?.name ?? node.login)
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

export interface RestAccount {
	login: string;
	html_url: string;
	avatar_url: string;
	email?: string | null;
	node_id: string;
	name?: string | null;
	type: string;
}

export function parseAccount(
	author: { login: string; url: string; avatarUrl: string; email?: string, id: string, name?: string, __typename: string } | RestAccount | null,
	githubRepository?: GitHubRepository,
): IAccount {
	if (author) {
		const avatarUrl = 'avatarUrl' in author ? author.avatarUrl : author.avatar_url;
		const id = 'node_id' in author ? author.node_id : author.id;
		const url = 'html_url' in author ? author.html_url : author.url;
		// In some places, Copilot comes in as a user, and in others as a bot
		return {
			login: author.login,
			url: COPILOT_ACCOUNTS[author.login]?.url ?? url,
			avatarUrl: githubRepository ? getAvatarWithEnterpriseFallback(avatarUrl, undefined, githubRepository.remote.isEnterprise) : avatarUrl,
			email: author.email ?? undefined,
			id,
			name: author.name ?? COPILOT_ACCOUNTS[author.login]?.name ?? undefined,
			specialDisplayName: COPILOT_ACCOUNTS[author.login] ? (author.name ?? COPILOT_ACCOUNTS[author.login].name) : undefined,
			accountType: toAccountType('__typename' in author ? author.__typename : author.type),
		};
	} else {
		return {
			login: '',
			url: '',
			id: '',
			accountType: AccountType.User
		};
	}
}

function parseTeam(team: GraphQL.Team, githubRepository: GitHubRepository): ITeam {
	return {
		name: team.name,
		url: team.url,
		avatarUrl: getAvatarWithEnterpriseFallback(team.avatarUrl, undefined, githubRepository.remote.isEnterprise),
		id: team.id,
		org: githubRepository.remote.owner,
		slug: team.slug
	};
}

export function parseGraphQLReviewers(data: GraphQL.GetReviewRequestsResponse, repository: GitHubRepository): (IAccount | ITeam)[] {
	if (!data.repository) {
		return [];
	}
	const reviewers: (IAccount | ITeam)[] = [];
	for (const reviewer of data.repository.pullRequest.reviewRequests.nodes) {
		if (GraphQL.isTeam(reviewer.requestedReviewer)) {
			const team: ITeam = parseTeam(reviewer.requestedReviewer, repository);
			reviewers.push(team);
		} else if (GraphQL.isAccount(reviewer.requestedReviewer)) {
			const account: IAccount = parseAccount(reviewer.requestedReviewer, repository);
			reviewers.push(account);
		}
	}
	return reviewers;
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

export function parseProjectItems(projects: { id: string; project: { id: string; title: string; } }[] | undefined): IProjectItem[] | undefined {
	if (!projects) {
		return undefined;
	}
	return projects.map(project => {
		return {
			id: project.id,
			project: project.project
		};
	});
}

export function parseMilestone(
	milestone: { title: string; dueOn?: string; createdAt: string; id: string, number: number } | undefined,
): IMilestone | undefined {
	if (!milestone) {
		return undefined;
	}
	return {
		title: milestone.title,
		dueOn: milestone.dueOn,
		createdAt: milestone.createdAt,
		id: milestone.id,
		number: milestone.number
	};
}

export function parseMergeQueueEntry(mergeQueueEntry: GraphQL.MergeQueueEntry | null | undefined): MergeQueueEntry | undefined | null {
	if (!mergeQueueEntry) {
		return null;
	}
	let state: MergeQueueState;
	switch (mergeQueueEntry.state) {
		case 'AWAITING_CHECKS': {
			state = MergeQueueState.AwaitingChecks;
			break;
		}
		case 'LOCKED': {
			state = MergeQueueState.Locked;
			break;
		}
		case 'QUEUED': {
			state = MergeQueueState.Queued;
			break;
		}
		case 'MERGEABLE': {
			state = MergeQueueState.Mergeable;
			break;
		}
		case 'UNMERGEABLE': {
			state = MergeQueueState.Unmergeable;
			break;
		}
	}
	return { position: mergeQueueEntry.position, state, url: mergeQueueEntry.mergeQueue.url };
}

export function parseMergeMethod(mergeMethod: GraphQL.MergeMethod | undefined): MergeMethod | undefined {
	switch (mergeMethod) {
		case 'MERGE': return 'merge';
		case 'REBASE': return 'rebase';
		case 'SQUASH': return 'squash';
	}
}

export function parseMergeability(mergeability: 'UNKNOWN' | 'MERGEABLE' | 'CONFLICTING' | undefined,
	mergeStateStatus: 'BEHIND' | 'BLOCKED' | 'CLEAN' | 'DIRTY' | 'HAS_HOOKS' | 'UNKNOWN' | 'UNSTABLE' | undefined): PullRequestMergeability {
	let parsed: PullRequestMergeability;
	switch (mergeability) {
		case undefined:
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

export async function parseGraphQLPullRequest(
	graphQLPullRequest: GraphQL.PullRequest,
	githubRepository: GitHubRepository,
): Promise<PullRequest> {
	const pr: PullRequest = {
		id: graphQLPullRequest.databaseId,
		graphNodeId: graphQLPullRequest.id,
		url: graphQLPullRequest.url,
		number: graphQLPullRequest.number,
		state: graphQLPullRequest.state,
		body: graphQLPullRequest.body,
		bodyHTML: await transformHtmlUrlsToExtensionUrls(graphQLPullRequest.bodyHTML, githubRepository),
		title: graphQLPullRequest.title,
		titleHTML: graphQLPullRequest.titleHTML,
		createdAt: graphQLPullRequest.createdAt,
		updatedAt: graphQLPullRequest.updatedAt,
		isRemoteHeadDeleted: !graphQLPullRequest.headRef,
		head: parseRef(graphQLPullRequest.headRef?.name ?? graphQLPullRequest.headRefName, graphQLPullRequest.headRefOid, graphQLPullRequest.headRepository),
		isRemoteBaseDeleted: !graphQLPullRequest.baseRef,
		base: parseRef(graphQLPullRequest.baseRef?.name ?? graphQLPullRequest.baseRefName, graphQLPullRequest.baseRefOid, graphQLPullRequest.baseRepository),
		user: parseAccount(graphQLPullRequest.author, githubRepository),
		merged: graphQLPullRequest.merged,
		mergeable: parseMergeability(graphQLPullRequest.mergeable, graphQLPullRequest.mergeStateStatus),
		mergeQueueEntry: parseMergeQueueEntry(graphQLPullRequest.mergeQueueEntry),
		hasComments: graphQLPullRequest.reviewThreads.totalCount > 0,
		autoMerge: !!graphQLPullRequest.autoMergeRequest,
		autoMergeMethod: parseMergeMethod(graphQLPullRequest.autoMergeRequest?.mergeMethod),
		allowAutoMerge: graphQLPullRequest.viewerCanEnableAutoMerge || graphQLPullRequest.viewerCanDisableAutoMerge,
		viewerCanUpdate: graphQLPullRequest.viewerCanUpdate,
		labels: graphQLPullRequest.labels.nodes,
		isDraft: graphQLPullRequest.isDraft,
		suggestedReviewers: parseSuggestedReviewers(graphQLPullRequest.suggestedReviewers),
		comments: parseComments(graphQLPullRequest.comments?.nodes, githubRepository),
		projectItems: parseProjectItems(graphQLPullRequest.projectItems?.nodes),
		milestone: parseMilestone(graphQLPullRequest.milestone),
		assignees: graphQLPullRequest.assignees?.nodes.map(assignee => parseAccount(assignee, githubRepository)),
		commits: parseCommits(graphQLPullRequest.commits.nodes),
		reactionCount: graphQLPullRequest.reactions.totalCount,
		reactions: parseGraphQLReaction(graphQLPullRequest.reactionGroups),
		commentCount: graphQLPullRequest.comments.totalCount,
	};
	pr.mergeCommitMeta = parseCommitMeta(graphQLPullRequest.baseRepository.mergeCommitTitle, graphQLPullRequest.baseRepository.mergeCommitMessage, pr);
	pr.squashCommitMeta = parseCommitMeta(graphQLPullRequest.baseRepository.squashMergeCommitTitle, graphQLPullRequest.baseRepository.squashMergeCommitMessage, pr);
	return pr;
}

function parseCommitMeta(titleSource: GraphQL.DefaultCommitTitle | undefined, descriptionSource: GraphQL.DefaultCommitMessage | undefined, pullRequest: PullRequest): { title: string, description: string } | undefined {
	if (titleSource === undefined || descriptionSource === undefined) {
		return undefined;
	}

	let title = '';
	let description = '';
	const prNumberPostfix = `(#${pullRequest.number})`;

	switch (titleSource) {
		case GraphQL.DefaultCommitTitle.prTitle: {
			title = `${pullRequest.title} ${prNumberPostfix}`;
			break;
		}
		case GraphQL.DefaultCommitTitle.mergeMessage: {
			title = `Merge pull request #${pullRequest.number} from ${pullRequest.head?.label ?? ''}`;
			break;
		}
		case GraphQL.DefaultCommitTitle.commitOrPrTitle: {
			if (pullRequest.commits.length === 1) {
				title = `${pullRequest.commits[0].message.split('\n')[0]} ${prNumberPostfix}`;
			} else {
				title = `${pullRequest.title} ${prNumberPostfix}`;
			}
			break;
		}
	}
	switch (descriptionSource) {
		case GraphQL.DefaultCommitMessage.prBody: {
			description = pullRequest.body;
			break;
		}
		case GraphQL.DefaultCommitMessage.commitMessages: {
			if ((pullRequest.commits.length === 1) && (titleSource === GraphQL.DefaultCommitTitle.commitOrPrTitle)) {
				const split = pullRequest.commits[0].message.split('\n');
				description = split.length > 1 ? split.slice(1).join('\n').trim() : '';
			} else {
				description = pullRequest.commits.map(commit => `* ${commit.message}`).join('\n\n');
			}
			break;
		}
		case GraphQL.DefaultCommitMessage.prTitle: {
			description = pullRequest.title;
			break;
		}
	}
	return { title, description };
}

function parseCommits(commits: { commit: { message: string; }; }[]): { message: string; }[] {
	return commits.map(commit => {
		return {
			message: commit.commit.message
		};
	});
}

function parseComments(comments: GraphQL.AbbreviatedIssueComment[] | undefined, githubRepository: GitHubRepository) {
	if (!comments) {
		return;
	}
	const parsedComments: {
		author: IAccount;
		body: string;
		databaseId: number;
		reactionCount: number;
		createdAt: string;
	}[] = [];
	for (const comment of comments) {
		parsedComments.push({
			author: parseAccount(comment.author, githubRepository),
			body: comment.body,
			databaseId: comment.databaseId,
			reactionCount: comment.reactions.totalCount,
			createdAt: comment.createdAt
		});
	}

	return parsedComments;
}

export async function parseGraphQLIssue(issue: GraphQL.Issue, githubRepository: GitHubRepository): Promise<Issue> {
	return {
		id: issue.databaseId,
		graphNodeId: issue.id,
		url: issue.url,
		number: issue.number,
		state: issue.state,
		body: issue.body,
		bodyHTML: await transformHtmlUrlsToExtensionUrls(issue.bodyHTML, githubRepository),
		title: issue.title,
		titleHTML: issue.titleHTML,
		createdAt: issue.createdAt,
		updatedAt: issue.updatedAt,
		assignees: issue.assignees?.nodes.map(assignee => parseAccount(assignee, githubRepository)),
		user: parseAccount(issue.author, githubRepository),
		labels: issue.labels.nodes,
		milestone: parseMilestone(issue.milestone),
		repositoryName: issue.repository?.name ?? githubRepository.remote.repositoryName,
		repositoryOwner: issue.repository?.owner.login ?? githubRepository.remote.owner,
		repositoryUrl: issue.repository?.url ?? githubRepository.remote.url,
		projectItems: parseProjectItems(issue.projectItems?.nodes),
		comments: issue.comments.nodes?.map(comment => parseIssueComment(comment, githubRepository)),
		reactionCount: issue.reactions.totalCount,
		reactions: parseGraphQLReaction(issue.reactionGroups),
		commentCount: issue.comments.totalCount
	};
}

function parseIssueComment(comment: GraphQL.AbbreviatedIssueComment, githubRepository: GitHubRepository): IIssueComment {
	return {
		author: parseAccount(comment.author, githubRepository),
		body: comment.body,
		databaseId: comment.databaseId,
		reactionCount: comment.reactions.totalCount,
		createdAt: comment.createdAt,
	};
}

function parseSuggestedReviewers(
	suggestedReviewers: GraphQL.SuggestedReviewerResponse[] | undefined,
): ISuggestedReviewer[] {
	if (!suggestedReviewers) {
		return [];
	}
	const ret: ISuggestedReviewer[] = suggestedReviewers.map(suggestedReviewer => {
		const account = parseAccount(suggestedReviewer.reviewer, undefined);
		return {
			...account,
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
/**
 * Used for case insensitive sort by team name
 */
export function teamComparator(a: ITeam, b: ITeam) {
	const aKey = a.name ?? a.slug ?? a.id;
	const bKey = b.name ?? b.slug ?? b.id;
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
		user: parseAccount(review.author, githubRepository),
		authorAssociation: review.authorAssociation,
		state: review.state,
		id: review.databaseId,
		reactions: parseGraphQLReaction(review.reactionGroups),
	};
}

export function parseSelectRestTimelineEvents(
	issueModel: IssueModel,
	events: OctokitCommon.ListEventsForTimelineResponse[]
): Common.TimelineEvent[] {
	const parsedEvents: Common.TimelineEvent[] = [];

	const prSessionLink: Common.SessionPullInfo = {
		id: issueModel.id,
		host: issueModel.githubRepository.remote.gitProtocol.host,
		owner: issueModel.githubRepository.remote.owner,
		repo: issueModel.githubRepository.remote.repositoryName,
		pullNumber: issueModel.number,
	};

	let sessionIndex = 0;
	for (const event of events) {
		const eventNode = event as { created_at?: string; node_id?: string; actor: RestAccount };
		if (eventNode.created_at && eventNode.node_id) {
			if (event.event === 'copilot_work_started') {
				parsedEvents.push({
					id: eventNode.node_id,
					event: Common.EventType.CopilotStarted,
					createdAt: eventNode.created_at,
					onBehalfOf: parseAccount(eventNode.actor),
					sessionLink: {
						...prSessionLink,
						sessionIndex
					}
				});
			} else if (event.event === 'copilot_work_finished') {
				parsedEvents.push({
					id: eventNode.node_id,
					event: Common.EventType.CopilotFinished,
					createdAt: eventNode.created_at,
					onBehalfOf: parseAccount(eventNode.actor)
				});
				sessionIndex++;
			} else if (event.event === 'copilot_work_finished_failure') {
				sessionIndex++;
				parsedEvents.push({
					id: eventNode.node_id,
					event: Common.EventType.CopilotFinishedError,
					createdAt: eventNode.created_at,
					onBehalfOf: parseAccount(eventNode.actor),
					sessionLink: {
						...prSessionLink,
						sessionIndex
					}
				});
			}
		}
	}

	return parsedEvents;
}

export function eventTime(event: Common.TimelineEvent): Date | undefined {
	switch (event.event) {
		case Common.EventType.Committed:
			return new Date(event.committedDate);
		case Common.EventType.Commented:
		case Common.EventType.Assigned:
		case Common.EventType.HeadRefDeleted:
		case Common.EventType.Merged:
		case Common.EventType.CrossReferenced:
		case Common.EventType.Closed:
		case Common.EventType.Reopened:
		case Common.EventType.CopilotStarted:
		case Common.EventType.CopilotFinished:
		case Common.EventType.CopilotFinishedError:
			return new Date(event.createdAt);
		case Common.EventType.Reviewed:
			return new Date(event.submittedAt);
		default:
			return undefined;
	}
}

export async function parseCombinedTimelineEvents(
	events: (
		| GraphQL.MergedEvent
		| GraphQL.Review
		| GraphQL.IssueComment
		| GraphQL.Commit
		| GraphQL.AssignedEvent
		| GraphQL.HeadRefDeletedEvent
		| GraphQL.CrossReferencedEvent
	)[],
	restEvents: Common.TimelineEvent[],
	githubRepository: GitHubRepository,
): Promise<Common.TimelineEvent[]> {
	const normalizedEvents: Common.TimelineEvent[] = [];
	let restEventIndex = -1;
	let restEventTime: number | undefined;
	const incrementRestEvent = () => {
		restEventIndex++;
		restEventTime = restEvents.length > restEventIndex ? eventTime(restEvents[restEventIndex])?.getTime() : undefined;
	};
	incrementRestEvent();
	const addTimelineEvent = (event: Common.TimelineEvent) => {
		if (!restEventTime) {
			normalizedEvents.push(event);
			return;
		}
		const newEventTime = eventTime(event)?.getTime();
		if (newEventTime) {
			while (restEventTime && newEventTime > restEventTime) {
				normalizedEvents.push(restEvents[restEventIndex]);
				incrementRestEvent();
			}
		}
		normalizedEvents.push(event);
	};

	// TODO: work the rest events into the appropriate place in the timeline
	for (const event of events) {
		const type = convertGraphQLEventType(event.__typename);

		switch (type) {
			case Common.EventType.Commented:
				const commentEvent = event as GraphQL.IssueComment;
				addTimelineEvent({
					htmlUrl: commentEvent.url,
					body: commentEvent.body,
					bodyHTML: commentEvent.bodyHTML,
					user: parseAccount(commentEvent.author, githubRepository),
					event: type,
					canEdit: commentEvent.viewerCanUpdate,
					canDelete: commentEvent.viewerCanDelete,
					id: commentEvent.databaseId,
					graphNodeId: commentEvent.id,
					createdAt: commentEvent.createdAt,
					reactions: parseGraphQLReaction(commentEvent.reactionGroups),
				});
				break;
			case Common.EventType.Reviewed:
				const reviewEvent = event as GraphQL.Review;
				addTimelineEvent({
					event: type,
					comments: [],
					submittedAt: reviewEvent.submittedAt,
					body: reviewEvent.body,
					bodyHTML: reviewEvent.bodyHTML,
					htmlUrl: reviewEvent.url,
					user: parseAccount(reviewEvent.author, githubRepository),
					authorAssociation: reviewEvent.authorAssociation,
					state: reviewEvent.state,
					id: reviewEvent.databaseId,
					reactions: parseGraphQLReaction(reviewEvent.reactionGroups),
				});
				break;
			case Common.EventType.Committed:
				const commitEv = event as GraphQL.Commit;
				addTimelineEvent({
					id: commitEv.id,
					event: type,
					sha: commitEv.commit.oid,
					author: commitEv.commit.author.user
						? parseAccount(commitEv.commit.author.user, githubRepository)
						: { login: commitEv.commit.committer.name },
					htmlUrl: commitEv.url,
					message: commitEv.commit.message,
					committedDate: new Date(commitEv.commit.committedDate),
				} as Common.CommitEvent); // TODO remove cast
				break;
			case Common.EventType.Merged:
				const mergeEv = event as GraphQL.MergedEvent;

				addTimelineEvent({
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
				break;
			case Common.EventType.Assigned:
				const assignEv = event as GraphQL.AssignedEvent;

				addTimelineEvent({
					id: assignEv.id,
					event: type,
					assignees: [parseAccount(assignEv.user, githubRepository)],
					actor: parseAccount(assignEv.actor),
					createdAt: assignEv.createdAt,
				});
				break;
			case Common.EventType.Unassigned:
				const unassignEv = event as GraphQL.UnassignedEvent;

				normalizedEvents.push({
					id: unassignEv.id,
					event: type,
					unassignees: [parseAccount(unassignEv.user, githubRepository)],
					actor: parseAccount(unassignEv.actor),
					createdAt: unassignEv.createdAt,
				});
				break;
			case Common.EventType.HeadRefDeleted:
				const deletedEv = event as GraphQL.HeadRefDeletedEvent;

				addTimelineEvent({
					id: deletedEv.id,
					event: type,
					actor: parseAccount(deletedEv.actor, githubRepository),
					createdAt: deletedEv.createdAt,
					headRef: deletedEv.headRefName,
				});
				break;
			case Common.EventType.CrossReferenced:
				const crossRefEv = event as GraphQL.CrossReferencedEvent;
				const isIssue = crossRefEv.source.__typename === 'Issue';
				const extensionUrl = isIssue
					? await toOpenIssueWebviewUri({ owner: crossRefEv.source.repository.owner.login, repo: crossRefEv.source.repository.name, issueNumber: crossRefEv.source.number })
					: await toOpenPullRequestWebviewUri({ owner: crossRefEv.source.repository.owner.login, repo: crossRefEv.source.repository.name, pullRequestNumber: crossRefEv.source.number });
				addTimelineEvent({
					id: crossRefEv.id,
					event: type,
					actor: parseAccount(crossRefEv.actor, githubRepository),
					createdAt: crossRefEv.createdAt,
					source: {
						url: crossRefEv.source.url,
						extensionUrl: extensionUrl.toString(),
						number: crossRefEv.source.number,
						title: crossRefEv.source.title,
						isIssue,
						owner: crossRefEv.source.repository.owner.login,
						repo: crossRefEv.source.repository.name,
					},
					willCloseTarget: crossRefEv.willCloseTarget
				});
				break;
			case Common.EventType.Closed:
				const closedEv = event as GraphQL.ClosedEvent;

				addTimelineEvent({
					id: closedEv.id,
					event: type,
					actor: parseAccount(closedEv.actor, githubRepository),
					createdAt: closedEv.createdAt,
				});
				break;
			case Common.EventType.Reopened:
				const reopenedEv = event as GraphQL.ReopenedEvent;

				addTimelineEvent({
					id: reopenedEv.id,
					event: type,
					actor: parseAccount(reopenedEv.actor, githubRepository),
					createdAt: reopenedEv.createdAt,
				});
				break;
			default:
				break;
		}
	}

	// Add any remaining rest events
	while (restEventTime) {
		normalizedEvents.push(restEvents[restEventIndex]);
		incrementRestEvent();
	}
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
		id: user.user.id,
		accountType: toAccountType(user.user.__typename)
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

export async function restPaginate<R extends OctokitTypes.RequestInterface, T>(request: R, variables: Parameters<R>[0], per_page: number = 100): Promise<T[]> {
	let page = 1;
	let results: T[] = [];
	let hasNextPage = false;

	do {
		const result = await request(
			{
				...(variables as any),
				per_page,
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

		if ((event.event === Common.EventType.Commented) && event.user) {
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
	if (viewerPermissionResponse && viewerPermissionResponse.repository?.viewerPermission) {
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
	const foundRepos: Repository[] = [];
	for (const repository of gitAPI.repositories.reverse()) {
		if (isFileInRepo(repository, file)) {
			foundRepos.push(repository);
		}
	}
	if (foundRepos.length > 0) {
		foundRepos.sort((a, b) => b.rootUri.path.length - a.rootUri.path.length);
		return foundRepos[0];
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
		const reviewEvent = reviewEvents[i];
		const reviewer = reviewEvent.user;
		if (reviewEvent.state && !seen.get(reviewer.login)) {
			seen.set(reviewer.login, true);
			reviewers.push({
				reviewer: reviewer,
				state: reviewEvent.state,
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

export function parseNotification(notification: OctokitCommon.Notification): Notification | undefined {
	if (!notification.subject.url) {
		return undefined;
	}
	const owner = notification.repository.owner.login;
	const name = notification.repository.name;
	const itemID = notification.subject.url.split('/').pop();

	return {
		owner,
		name,
		key: getNotificationKey(owner, name, itemID!),
		id: notification.id,
		itemID: itemID!,
		subject: {
			title: notification.subject.title,
			type: notification.subject.type as NotificationSubjectType,
			url: notification.subject.url
		},
		lastReadAt: notification.last_read_at ? new Date(notification.last_read_at) : undefined,
		reason: notification.reason,
		unread: notification.unread,
		updatedAd: new Date(notification.updated_at),
	};
}

export function getNotificationKey(owner: string, name: string, itemID: string): string {
	return `${owner}/${name}#${itemID}`;
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

export function getPRFetchQuery(user: string, query: string): string {
	const filter = query.replace(/\$\{user\}/g, user);
	return `is:pull-request ${filter} type:pr`;
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
		crypto.createHash('sha256').update(email?.trim()?.toLowerCase()).digest('hex')) : undefined);
}

export function getPullsUrl(repo: GitHubRepository) {
	return vscode.Uri.parse(`https://${repo.remote.host}/${repo.remote.owner}/${repo.remote.repositoryName}/pulls`);
}

export function getIssuesUrl(repo: GitHubRepository) {
	return vscode.Uri.parse(`https://${repo.remote.host}/${repo.remote.owner}/${repo.remote.repositoryName}/issues`);
}

export function sanitizeIssueTitle(title: string): string {
	const regex = /[~^:;'".,~#?%*&[\]@\\{}()/]|\/\//g;

	return title.replace(regex, '').trim().substring(0, 150).replace(/\s+/g, '-');
}

const SINCE_VALUE_PATTERN = /-([0-9]+)([d])/;
function computeSinceValue(sinceValue: string | undefined): string {
	const match = sinceValue ? SINCE_VALUE_PATTERN.exec(sinceValue) : undefined;
	const date = new Date();
	if (match && match.length === 3 && match[2] === 'd') {
		const dateOffset = parseInt(match[1]) * (24 * 60 * 60 * 1000);
		date.setTime(date.getTime() - dateOffset);
	}
	const month = `${date.getMonth() + 1}`;
	const day = `${date.getDate()}`;
	return `${date.getFullYear()}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

const COPILOT_PATTERN = /\:(Copilot|copilot)(\s|$)/g;

const VARIABLE_PATTERN = /\$\{([^-]*?)(-.*?)?\}/g;
export async function variableSubstitution(
	value: string,
	issueModel?: IssueModel,
	defaults?: PullRequestDefaults,
	user?: string,
): Promise<string> {
	const withVariables = value.replace(VARIABLE_PATTERN, (match: string, variable: string, extra: string) => {
		let result: string;
		switch (variable) {
			case 'user':
				result = user ? user : match;
				break;
			case 'issueNumber':
				result = issueModel ? `${issueModel.number}` : match;
				break;
			case 'issueNumberLabel':
				result = issueModel ? `${getIssueNumberLabel(issueModel, defaults)}` : match;
				break;
			case 'issueTitle':
				result = issueModel ? issueModel.title : match;
				break;
			case 'repository':
				result = defaults ? defaults.repo : match;
				break;
			case 'owner':
				result = defaults ? defaults.owner : match;
				break;
			case 'sanitizedIssueTitle':
				result = issueModel ? sanitizeIssueTitle(issueModel.title) : match; // check what characters are permitted
				break;
			case 'sanitizedLowercaseIssueTitle':
				result = issueModel ? sanitizeIssueTitle(issueModel.title).toLowerCase() : match;
				break;
			case 'today':
				result = computeSinceValue(extra);
				break;
			default:
				result = match;
				break;
		}
		Logger.debug(`${match} -> ${result}`, 'VariableSubstitution');
		return result;
	});

	// not a variable, but still a substitution that needs to be done
	const withCopilot = withVariables.replace(COPILOT_PATTERN, () => {
		return `:copilot-swe-agent[bot] `;
	});
	return withCopilot;
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

export function vscodeDevPrLink(pullRequest: IssueModel) {
	const itemUri = vscode.Uri.parse(pullRequest.html_url);
	return `https://${vscode.env.appName.toLowerCase().includes('insider') ? 'insiders.' : ''}vscode.dev/github${itemUri.path}`;
}

export function makeLabel(label: ILabel): string {
	const isDarkTheme = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark;
	const labelColor = gitHubLabelColor(label.color, isDarkTheme, true);
	return `<span style="color:${labelColor.textColor};background-color:${labelColor.backgroundColor};border-radius:10px;">&nbsp;&nbsp;${label.name.trim()}&nbsp;&nbsp;</span>`;
}


export enum UnsatisfiedChecks {
	None = 0,
	ReviewRequired = 1 << 0,
	ChangesRequested = 1 << 1,
	CIFailed = 1 << 2,
	CIPending = 1 << 3
}