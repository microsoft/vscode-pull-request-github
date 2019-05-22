import * as REST from '@octokit/rest';

type Omit<T, K extends keyof T> = Pick<T, Exclude<keyof T, K>>;

declare namespace Github {
	export type PullRequestsGetResponse = Omit<REST.PullsGetResponse, 'milestone'> & {
		milestone: null | REST.PullsGetResponseMilestone
	};
	export type PullRequestsGetAllResponseItem = Omit<REST.PullsListResponseItem, 'milestone' | 'closed_at' | 'merged_at' | '_links'> & {
		milestone: null | REST.PullsGetResponseMilestone
	};

	export type PullRequestsGetAllResponseItemUser = REST.PullsListResponseItemUser;
	export type PullRequestsGetResponseHead = REST.PullsGetResponseHead;
	export type PullRequestsCreateResponse = REST.PullsCreateResponse;
	export type IssuesCreateCommentResponse = REST.IssuesCreateCommentResponse;
	export type IssuesEditCommentResponse = REST.IssuesUpdateCommentResponse;
	export type PullRequestsGetCommentsResponseItem = REST.PullsListCommentsResponseItem;
	export type PullRequestsEditCommentResponse = REST.PullsUpdateCommentResponse;
	export type PullRequestsGetResponseHeadRepo = REST.PullsGetResponseHeadRepo;
	export type PullRequestsCreateReviewResponse = REST.PullsCreateReviewResponse;
}
// Octokit.PullRequestsGetResponse | Octokit.PullRequestsGetAllResponseItem

export = Github;