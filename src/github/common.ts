import * as OctokitRest from '@octokit/rest';
import * as OctokitTypes from '@octokit/types';

export namespace OctokitCommon {
	export type IssuesCreateParams = OctokitRest.RestEndpointMethodTypes['issues']['create']['parameters'];
	export type IssuesAssignParams = OctokitRest.RestEndpointMethodTypes['issues']['addAssignees']['parameters'];
	export type PullsCreateParams = OctokitRest.RestEndpointMethodTypes['pulls']['create']['parameters'];
	export type ReposGetCombinedStatusForRefResponseStatusesItem = OctokitTypes.ReposGetCombinedStatusForRefResponseData['statuses'][0];
	export type ReposGetResponseOrganization = OctokitTypes.ReposGetResponseData['organization'];
	export type PullsListResponseItem = OctokitTypes.PullsListResponseData[0];
	export type PullsListResponseItemHead = PullsListResponseItem['head'];
	export type PullsListResponseItemBase = PullsListResponseItem['base'];
	export type PullsListResponseItemHeadRepo = PullsListResponseItemHead['repo'];
	export type PullsListResponseItemBaseRepo = PullsListResponseItemBase['repo'];
	export type PullsListResponseItemUser = PullsListResponseItem['user'];
	export type PullsListResponseItemAssignee = PullsListResponseItem['assignee'];
	export type PullsListResponseItemAssigneesItem = PullsListResponseItem['assignees'][0];
	export type PullsListResponseItemRequestedReviewersItem = PullsListResponseItem['requested_reviewers'][0];
	export type PullsListResponseItemBaseUser = PullsListResponseItemBase['user'];
	export type PullsListResponseItemBaseRepoOwner = PullsListResponseItemBase['repo']['owner'];
	export type PullsListResponseItemHeadUser = PullsListResponseItemHead['user'];
	export type PullsListResponseItemHeadRepoOwner = PullsListResponseItemHead['repo']['owner'];
	export type IssuesListEventsForTimelineResponseItemActor = OctokitTypes.IssuesListEventsForTimelineResponseData[0]['actor'];
	export type PullsListReviewRequestsResponseTeamsItem = OctokitTypes.PullsListRequestedReviewersResponseData['teams'][0];
	export type PullsListResponseItemHeadRepoTemplateRepository = PullsListResponseItem['head']['repo']['template_repository'];
	export type ReposGetResponseCodeOfConduct = OctokitTypes.ReposGetResponseData['code_of_conduct'];
	export type PullsListCommitsResponseItem = OctokitTypes.PullsListCommitsResponseData[0];
	export type SearchReposResponseItem = OctokitTypes.SearchReposResponseData['items'][0];

}