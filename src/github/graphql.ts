/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DiffSide, ViewedState } from '../common/comment';
import { ForkDetails } from './githubRepository';

export interface MergedEvent {
	__typename: string;
	id: string;
	actor: {
		login: string;
		avatarUrl: string;
		url: string;
	};
	createdAt: string;
	mergeRef: {
		name: string;
	};
	commit: {
		oid: string;
		commitUrl: string;
	};
	url: string;
}

export interface HeadRefDeletedEvent {
	__typename: string;
	id: string;
	actor: {
		login: string;
		avatarUrl: string;
		url: string;
	};
	createdAt: string;
	headRefName: string;
}

export interface AbbreviatedIssueComment {
	author: {
		login: string;
		avatarUrl: string;
		url: string;
		email?: string
	};
	body: string;
	databaseId: number;
}

export interface IssueComment extends AbbreviatedIssueComment {
	__typename: string;
	authorAssociation: string;
	id: string;
	url: string;
	bodyHTML: string;
	updatedAt: string;
	createdAt: string;
	viewerCanUpdate: boolean;
	viewerCanReact: boolean;
	viewerCanDelete: boolean;
}

export interface ReactionGroup {
	content: string;
	viewerHasReacted: boolean;
	users: {
		totalCount: number;
	};
}

export interface Account {
	login: string;
	avatarUrl: string;
	name: string;
	url: string;
	email: string;
}

interface Team {
	avatarUrl: string;
	name: string;
	url: string;
	repositories: {
		nodes: {
			name: string
		}[];
	};
	slug: string;
	id: string;
}

export interface ReviewComment {
	__typename: string;
	id: string;
	databaseId: number;
	url: string;
	author?: {
		login: string;
		avatarUrl: string;
		url: string;
	};
	path: string;
	originalPosition: number;
	body: string;
	bodyHTML: string;
	diffHunk: string;
	position: number;
	state: string;
	pullRequestReview: {
		databaseId: number;
	};
	commit: {
		oid: string;
	};
	originalCommit: {
		oid: string;
	};
	createdAt: string;
	replyTo: {
		databaseId: number;
	};
	reactionGroups: ReactionGroup[];
	viewerCanUpdate: boolean;
	viewerCanDelete: boolean;
}

export interface Commit {
	__typename: string;
	id: string;
	commit: {
		author: {
			user: {
				login: string;
				avatarUrl: string;
				url: string;
			};
		};
		committer: {
			avatarUrl: string;
			name: string;
		};
		oid: string;
		message: string;
		authoredDate: Date;
	};

	url: string;
}

export interface AssignedEvent {
	__typename: string;
	id: number;
	actor: {
		login: string;
		avatarUrl: string;
		url: string;
	};
	user: {
		login: string;
		avatarUrl: string;
		url: string;
	};
}

export interface Review {
	__typename: string;
	id: string;
	databaseId: number;
	authorAssociation: string;
	url: string;
	author: {
		login: string;
		avatarUrl: string;
		url: string;
	};
	state: 'COMMENTED' | 'APPROVED' | 'CHANGES_REQUESTED' | 'PENDING';
	body: string;
	bodyHTML?: string;
	submittedAt: string;
	updatedAt: string;
	createdAt: string;
}

export interface ReviewThread {
	id: string;
	isResolved: boolean;
	viewerCanResolve: boolean;
	viewerCanUnresolve: boolean;
	path: string;
	diffSide: DiffSide;
	startLine: number | null;
	line: number;
	originalStartLine: number | null;
	originalLine: number;
	isOutdated: boolean;
	comments: {
		nodes: ReviewComment[];
		edges: [{
			node: {
				pullRequestReview: {
					databaseId: number
				}
			}
		}]
	};
}

export interface TimelineEventsResponse {
	repository: {
		pullRequest: {
			timelineItems: {
				nodes: (MergedEvent | Review | IssueComment | Commit | AssignedEvent | HeadRefDeletedEvent)[];
			};
		};
	};
	rateLimit: RateLimit;
}

export interface LatestReviewCommitResponse {
	repository: {
		pullRequest: {
			viewerLatestReview: {
				commit: {
					oid: string;
				}
			};
		};
	};
}

export interface PendingReviewIdResponse {
	node: {
		reviews: {
			nodes: Review[];
		};
	};
	rateLimit: RateLimit;
}

export interface GetReviewRequestsResponse {
	repository: {
		pullRequest: {
			reviewRequests: {
				nodes: {
					requestedReviewer: {
						// Shared properties between accounts and teams
						avatarUrl: string;
						url: string;
						name: string;
						// Account properties
						login?: string;
						email?: string;
						// Team properties
						slug?: string;
						id?: string;
					};
				}[];
			};
		};
	};
};

export interface PullRequestState {
	repository: {
		pullRequest: {
			title: string;
			number: number;
			state: 'OPEN' | 'CLOSED' | 'MERGED';
		};
	};
}

export interface PullRequestCommentsResponse {
	repository: {
		pullRequest: {
			reviewThreads: {
				nodes: ReviewThread[];
			};
		};
	};
}

export interface MentionableUsersResponse {
	repository: {
		mentionableUsers: {
			nodes: Account[];
			pageInfo: {
				hasNextPage: boolean;
				endCursor: string;
			};
		};
	};
	rateLimit: RateLimit;
}

export interface AssignableUsersResponse {
	repository: {
		assignableUsers: {
			nodes: Account[];
			pageInfo: {
				hasNextPage: boolean;
				endCursor: string;
			};
		};
	};
	rateLimit: RateLimit;
}

export interface OrganizationTeamsCountResponse {
	organization: {
		teams: {
			totalCount: number;
		};
	};
}

export interface OrganizationTeamsResponse {
	organization: {
		teams: {
			nodes: Team[];
			totalCount: number;
			pageInfo: {
				hasNextPage: boolean;
				endCursor: string;
			};
		};
	};
	rateLimit: RateLimit;
}

export interface PullRequestParticipantsResponse {
	repository: {
		pullRequest: {
			participants: {
				nodes: Account[];
			};
		};
	};
}

export interface CreatePullRequestResponse {
	createPullRequest: {
		pullRequest: PullRequest
	}
}

export interface AddReviewThreadResponse {
	addPullRequestReviewThread: {
		thread: ReviewThread;
	}
}

export interface AddCommentResponse {
	addPullRequestReviewComment: {
		comment: ReviewComment;
	};
}

export interface AddIssueCommentResponse {
	addComment: {
		commentEdge: {
			node: IssueComment;
		};
	};
}

export interface EditCommentResponse {
	updatePullRequestReviewComment: {
		pullRequestReviewComment: ReviewComment;
	};
}

export interface EditIssueCommentResponse {
	updateIssueComment: {
		issueComment: IssueComment;
	};
}

export interface MarkPullRequestReadyForReviewResponse {
	markPullRequestReadyForReview: {
		pullRequest: {
			isDraft: boolean;
		};
	};
}

export interface SubmittedReview extends Review {
	comments: {
		nodes: ReviewComment[];
	};
}

export interface SubmitReviewResponse {
	submitPullRequestReview: {
		pullRequestReview: SubmittedReview;
	};
}

export interface DeleteReviewResponse {
	deletePullRequestReview: {
		pullRequestReview: {
			databaseId: number;
			comments: {
				nodes: ReviewComment[];
			};
		};
	};
}

export interface AddReactionResponse {
	addReaction: {
		reaction: {
			content: string;
		};
		subject: {
			reactionGroups: ReactionGroup[];
		};
	};
}

export interface DeleteReactionResponse {
	removeReaction: {
		reaction: {
			content: string;
		};
		subject: {
			reactionGroups: ReactionGroup[];
		};
	};
}

export interface UpdatePullRequestResponse {
	updatePullRequest: {
		pullRequest: {
			body: string;
			bodyHTML: string;
			title: string;
			titleHTML: string;
		};
	};
}

export interface ListBranchesResponse {
	repository: {
		refs: {
			nodes: {
				name: string;
			}[];
			pageInfo: {
				hasNextPage: boolean;
				endCursor: string;
			};
		};
	};
}

export interface RefRepository {
	isInOrganization: boolean;
	owner: {
		login: string;
	};
	url: string;
}
export interface Ref {
	name: string;
	repository: RefRepository;
	target: {
		oid: string;
	};
}

export interface SuggestedReviewerResponse {
	isAuthor: boolean;
	isCommenter: boolean;
	reviewer: {
		login: string;
		avatarUrl: string;
		name: string;
		url: string;
	};
}

export interface PullRequest {
	id: string;
	databaseId: number;
	number: number;
	url: string;
	state: 'OPEN' | 'CLOSED' | 'MERGED';
	body: string;
	bodyHTML: string;
	title: string;
	titleHTML: string;
	assignees?: {
		nodes: {
			login: string;
			url: string;
			email: string;
			avatarUrl: string;
		}[];
	};
	author: {
		login: string;
		url: string;
		avatarUrl: string;
	};
	comments?: {
		nodes: AbbreviatedIssueComment[];
	};
	createdAt: string;
	updatedAt: string;
	headRef?: Ref;
	headRefName: string;
	headRefOid: string;
	headRepository?: RefRepository;
	baseRef?: Ref;
	baseRefName: string;
	baseRefOid: string;
	baseRepository: RefRepository;
	labels: {
		nodes: {
			name: string;
			color: string;
		}[];
	};
	merged: boolean;
	mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
	mergeStateStatus: 'BEHIND' | 'BLOCKED' | 'CLEAN' | 'DIRTY' | 'HAS_HOOKS' | 'UNKNOWN' | 'UNSTABLE';
	autoMergeRequest?: {
		mergeMethod: 'MERGE' | 'REBASE' | 'SQUASH'
	};
	viewerCanEnableAutoMerge: boolean;
	viewerCanDisableAutoMerge: boolean;
	isDraft?: boolean;
	suggestedReviewers: SuggestedReviewerResponse[];
	milestone?: {
		title: string;
		dueOn?: string;
		id: string;
		createdAt: string;
	};
	repository?: {
		name: string;
		owner: {
			login: string;
		};
		url: string;
	};
}

export interface PullRequestResponse {
	repository: {
		pullRequest: PullRequest;
	};
	rateLimit: RateLimit;
}

export interface PullRequestMergabilityResponse {
	repository: {
		pullRequest: {
			mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
			mergeStateStatus: 'BEHIND' | 'BLOCKED' | 'CLEAN' | 'DIRTY' | 'HAS_HOOKS' | 'UNKNOWN' | 'UNSTABLE';
		};
	};
	rateLimit: RateLimit;
}

export interface IssuesSearchResponse {
	search: {
		issueCount: number;
		pageInfo: {
			hasNextPage: boolean;
			endCursor: string;
		};
		edges: {
			node: PullRequest;
		}[];
	};
	rateLimit: RateLimit;
}

export interface MilestoneIssuesResponse {
	repository: {
		milestones: {
			nodes: {
				dueOn: string;
				createdAt: string;
				title: string;
				id: string;
				issues: {
					edges: {
						node: PullRequest;
					}[];
				};
			}[];
			pageInfo: {
				hasNextPage: boolean;
				endCursor: string;
			};
		};
	};
}

export interface IssuesResponse {
	repository: {
		issues: {
			edges: {
				node: PullRequest;
			}[];
			pageInfo: {
				hasNextPage: boolean;
				endCursor: string;
			};
		};
	};
}

export interface PullRequestsResponse {
	repository: {
		pullRequests: {
			nodes: PullRequest[]
		}
	}
}

export interface MaxIssueResponse {
	repository: {
		issues: {
			edges: {
				node: {
					number: number;
				};
			}[];
		};
	};
}

export interface ViewerPermissionResponse {
	repository: {
		viewerPermission: string;
	};
}

export interface ForkDetailsResponse {
	repository: ForkDetails;
}

export interface QueryWithRateLimit {
	rateLimit: RateLimit;
}
export interface RateLimit {
	limit: number;
	cost: number;
	remaining: number;
	resetAt: string;
}

export interface ContributionsCollection {
	commitContributionsByRepository: {
		contributions: {
			nodes: {
				occurredAt: string;
			}[];
		};
		repository: {
			nameWithOwner: string;
		};
	}[];
}

export interface UserResponse {
	user: {
		login: string;
		avatarUrl?: string;
		bio?: string;
		company?: string;
		location?: string;
		name: string;
		contributionsCollection: ContributionsCollection;
		url: string;
	};
}

export interface FileContentResponse {
	repository: {
		object: {
			text: string | undefined;
		}
	}
}

export interface StartReviewResponse {
	addPullRequestReview: {
		pullRequestReview: {
			id: string;
		};
	};
}

export interface StatusContext {
	id: string;
	state?: 'ERROR' | 'EXPECTED' | 'FAILURE' | 'PENDING' | 'SUCCESS';
	description?: string;
	context: string;
	targetUrl?: string;
	avatarUrl?: string;
}

export interface CheckRun {
	id: string;
	conclusion?:
	| 'ACTION_REQUIRED'
	| 'CANCELLED'
	| 'FAILURE'
	| 'NEUTRAL'
	| 'SKIPPED'
	| 'STALE'
	| 'SUCCESS'
	| 'TIMED_OUT';
	name: string;
	title?: string;
	detailsUrl?: string;
	checkSuite?: {
		app?: {
			logoUrl: string;
			url: string;
		};
	};
}

export function isCheckRun(x: CheckRun | StatusContext): x is CheckRun {
	return (x as any).__typename === 'CheckRun';
}

export interface GetChecksResponse {
	repository: {
		pullRequest: {
			commits: {
				nodes: {
					commit: {
						statusCheckRollup?: {
							state: string;
							contexts: {
								nodes: (StatusContext | CheckRun)[];
							};
						};
					};
				}[];
			};
		};
	};
}

export interface LatestReviewsResponse {
	repository: {
		pullRequest: {
			latestReviews: {
				nodes: {
					state: 'COMMENTED' | 'APPROVED' | 'CHANGES_REQUESTED' | 'PENDING';
				}[]
			}
		}
	}
}

export interface ResolveReviewThreadResponse {
	resolveReviewThread: {
		thread: ReviewThread;
	}
}

export interface UnresolveReviewThreadResponse {
	unresolveReviewThread: {
		thread: ReviewThread;
	}
}

export interface PullRequestFilesResponse {
	repository: {
		pullRequest: {
			files: {
				nodes: {
					path: string;
					viewerViewedState: ViewedState
				}[]
				pageInfo: {
					hasNextPage: boolean;
					endCursor: string;
				};
			}
		}
	}
}