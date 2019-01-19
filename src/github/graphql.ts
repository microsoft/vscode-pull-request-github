/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface MergedEvent {
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
}

export interface IssueComment {
	id: string;
	databaseId: number;
	authorAssocation: string;
	author: {
		login: string;
		avatarUrl: string;
		url: string;
	};
	url: string;
	body: string;
	updatedAt: string;
	createdAt: string;
	viewerCanUpdate: boolean;
	viewerCanReact: boolean;
	viewerCanDelete: boolean;
}

export interface ReviewComment {
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
	viewerCanUpdate: boolean;
	viewerCanDelete: boolean;
}

export interface Commit {
	id: string;
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
	url: string;
	oid: string;
	message: string;
}

export interface AssignedEvent {
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
	id: string;
	databaseId: number;
	authorAssocation: string;
	author: {
		login: string;
		avatarUrl: string;
		url: string;
	};
	state: string;
	body: string;
	submittedAt: string;
	updatedAt: string;
	createdAt: string;
}

export interface TimelineEventsResponse {
	repository: {
		pullRequest: {
			timeline: {
				edges: [
					{
						node: (MergedEvent | Review | IssueComment | Commit | AssignedEvent)[];
					}
				]
			}
		}
	};
}

export interface PendingReviewIdResponse {
	node: {
		reviews: {
			nodes: Review[];
		}
	};
}

export interface PullRequestCommentsResponse {
	repository: {
		pullRequest: {
			reviews: {
				nodes: [
					{
						comments: {
							nodes: ReviewComment[];
						}
					}
				]
			}
		}
	};
}

export interface AddCommentResponse {
	addPullRequestReviewComment: {
		comment: ReviewComment;
	};
}

export interface SubmitReviewResponse {
	submitPullRequestReview: {
		pullRequestReview: {
			comments: {
				nodes: ReviewComment[];
			}
		}
	};
}

export interface DeleteReviewResponse {
	deletePullRequestReview: {
		pullRequestReview: {
			comments: {
				nodes: ReviewComment[];
			}
		}
	};
}