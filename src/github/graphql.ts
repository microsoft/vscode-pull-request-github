/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ForkDetails } from './githubRepository';

export interface MergedEvent {
	__typename: string;
	id: string;
	databaseId: number;
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
	};
	body: string;
	databaseId: number;
}

export interface IssueComment extends AbbreviatedIssueComment {
	__typename: string;
	authorAssocation: string;
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
	databaseId: number;
	commit: {
		author: {
			user: {
				login: string;
				avatarUrl: string;
				url: string;
			}
		};
		committer: {
			avatarUrl: string;
			name: string;
		};
		oid: string;
		message: string;
		authoredDate: Date
	};

	url: string;
}

export interface AssignedEvent {
	__typename: string;
	databaseId: number;
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

export interface TimelineEventsResponse {
	repository: {
		pullRequest: {
			timelineItems: {
				nodes: (MergedEvent | Review | IssueComment | Commit | AssignedEvent | HeadRefDeletedEvent)[];
			}
		}
	};
	rateLimit: RateLimit;
}

export interface PendingReviewIdResponse {
	node: {
		reviews: {
			nodes: Review[];
		}
	};
	rateLimit: RateLimit;
}

export interface PullRequestState {
	repository: {
		pullRequest: {
			title: string;
			number: number;
			state: 'OPEN' | 'CLOSED' | 'MERGED';
		}
	};
}

export interface PullRequestCommentsResponse {
	repository: {
		pullRequest: {
			reviewThreads: {
				nodes: [
					{
						isResolved: boolean;
						comments: {
							nodes: ReviewComment[];
						}
					}
				]
			}
		}
	};
	rateLimit: RateLimit;
}

export interface MentionableUsersResponse {
	repository: {
		mentionableUsers: {
			nodes: {
				login: string;
				avatarUrl: string;
				name: string;
				url: string;
				email: string;
			}[];
			pageInfo: {
				hasNextPage: boolean;
				endCursor: string;
			};
		}
	};
	rateLimit: RateLimit;
}

export interface AssignableUsersResponse {
	repository: {
		assignableUsers: {
			nodes: {
				login: string;
				avatarUrl: string;
				name: string;
				url: string;
				email: string;
			}[];
			pageInfo: {
				hasNextPage: boolean;
				endCursor: string;
			};
		}
	};
	rateLimit: RateLimit;
}

export interface AddCommentResponse {
	addPullRequestReviewComment: {
		comment: ReviewComment;
	};
}

export interface AddIssueCommentResponse {
	addComment: {
		commentEdge: {
			node: IssueComment
		}
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
			isDraft: boolean
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
			}
		}
	};
}

export interface AddReactionResponse {
	addReaction: {
		reaction: {
			content: string;
		}
		subject: {
			reactionGroups: ReactionGroup[];
		}
	};
}

export interface DeleteReactionResponse {
	removeReaction: {
		reaction: {
			content: string;
		}
		subject: {
			reactionGroups: ReactionGroup[];
		}
	};
}

export interface UpdatePullRequestResponse {
	updatePullRequest: {
		pullRequest: {
			body: string;
			bodyHTML: string;
			title: string;
		};
	};
}

export interface Ref {
	name: string;
	repository: {
		owner: {
			login: string;
		}
		url: string;
	};
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
	assignees: {
		nodes: {
			login: string;
			url: string;
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
	baseRef?: Ref;
	labels: {
		nodes: {
			name: string;
			color: string;
		}[];
	};
	merged: boolean;
	mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
	isDraft?: boolean;
	suggestedReviewers: SuggestedReviewerResponse[];
	milestone?: {
		title: string,
		dueOn?: string,
		id: string,
		createdAt: string
	};
	repository?: {
		name: string,
		owner: {
			login: string
		},
		url: string
	};
}

export interface PullRequestResponse {
	repository: {
		pullRequest: PullRequest;
	};
	rateLimit: RateLimit;
}

export interface IssuesSearchResponse {
	search: {
		issueCount: number,
		pageInfo: {
			hasNextPage: boolean
			endCursor: string
		},
		edges: {
			node: PullRequest
		}[]
	};
	rateLimit: RateLimit;
}

export interface MilestoneIssuesResponse {
	repository: {
		milestones: {
			nodes: {
				dueOn: string,
				createdAt: string,
				title: string,
				id: string,
				issues: {
					edges: {
						node: PullRequest
					}[]
				}
			}[],
			pageInfo: {
				hasNextPage: boolean;
				endCursor: string;
			}
		}
	};
}

export interface IssuesResponse {
	repository: {
		issues: {
			edges: {
				node: PullRequest
			}[],
			pageInfo: {
				hasNextPage: boolean;
				endCursor: string;
			}
		}
	};
}

export interface MaxIssueResponse {
	repository: {
		issues: {
			edges: {
				node: {
					number: number
				}
			}[]
		}
	};
}

export interface ViewerPermissionResponse {
	repository: {
		viewerPermission: string
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

export interface StartReviewResponse {
	addPullRequestReview: {
		pullRequestReview: {
			comments: {
				nodes: ReviewComment[]
			}
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
	conclusion?: 'ACTION_REQUIRED' | 'CANCELLED' | 'FAILURE' | 'NEUTRAL' | 'SKIPPED' | 'STALE' | 'SUCCESS' | 'TIMED_OUT';
	name: string;
	title?: string;
	detailsUrl?: string;
	checkSuite: {
		app?: {
			logoUrl: string;
			url: string;
		};
	};
}

export function isCheckRun(x: CheckRun | StatusContext): x is CheckRun {
	return !!(x as CheckRun).conclusion;
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
								nodes: (StatusContext | CheckRun)[]
							}
						}
					}
				}[]
			}
		}
	};
}
