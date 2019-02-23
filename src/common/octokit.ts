import * as REST from '@octokit/rest';

type Omit<T, K extends keyof T> = Pick<T, Exclude<keyof T, K>>;

declare namespace Github {
	export type PullRequestsGetResponse = Omit<REST.PullRequestsGetResponse, 'milestone'> & {
		milestone: null | REST.PullRequestsGetResponseMilestone
	};
	export type PullRequestsGetAllResponseItem = Omit<REST.PullRequestsGetAllResponseItem, 'milestone' | 'closed_at' | 'merged_at' | '_links'> & {
		milestone: null | REST.PullRequestsGetResponseMilestone
	};

	export type PullRequestsGetAllResponseItemUser = REST.PullRequestsGetAllResponseItemUser;
	export type PullRequestsGetResponseHead = REST.PullRequestsGetResponseHead;
	export type PullRequestsCreateResponse = REST.PullRequestsCreateResponse;
	export type IssuesCreateCommentResponse = REST.IssuesCreateCommentResponse;
	export type IssuesEditCommentResponse = REST.IssuesEditCommentResponse;
	export type PullRequestsGetCommentsResponseItem = REST.PullRequestsGetCommentsResponseItem;
	export type PullRequestsEditCommentResponse = REST.PullRequestsEditCommentResponse;
	export type PullRequestsGetResponseHeadRepo = REST.PullRequestsGetResponseHeadRepo;
	export type PullRequestsCreateReviewResponse = REST.PullRequestsCreateReviewResponse;
}
// Octokit.PullRequestsGetResponse | Octokit.PullRequestsGetAllResponseItem

export = Github;