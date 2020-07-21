import * as OctokitRest from '@octokit/rest';
import * as OctokitTypes from '@octokit/types';

export namespace OctokitCommon {
	export type IssuesCreateParams = OctokitRest.RestEndpointMethodTypes['issues']['create']['parameters'];
	export type PullsCreateParams = OctokitRest.RestEndpointMethodTypes['pulls']['create']['parameters'];
	export type ReposGetCombinedStatusForRefResponseStatusesItem = OctokitTypes.ReposGetCombinedStatusForRefResponseData['statuses'][0];
	export type ReposGetResponseOrganization = OctokitTypes.ReposGetResponseData['organization'];
	export type PullsListResponseItemHead = OctokitTypes.PullsListResponseData[0]['head'];
	export type PullsListResponseItemBase = OctokitTypes.PullsListResponseData[0]['base'];
	export type PullsListResponseItemHeadRepo = PullsListResponseItemHead['repo'];
	export type PullsListResponseItemBaseRepo = PullsListResponseItemBase['repo'];
	export type PullsListResponseItemUser = OctokitTypes.PullsListResponseData[0]['user'];
	export type PullsListResponseItemAssignee = OctokitTypes.PullsListResponseData[0]['assignee'];
	export type PullsListResponseItemAssigneesItem = OctokitTypes.PullsListResponseData[0]['assignees'][0];
	export type PullsListResponseItemRequestedReviewersItem = OctokitTypes.PullsListResponseData[0]['requested_reviewers'][0];
	export type PullsListResponseItemBaseUser = PullsListResponseItemBase['user'];
	export type PullsListResponseItemBaseRepoOwner = PullsListResponseItemBase['repo']['owner'];
	export type PullsListResponseItemHeadUser = PullsListResponseItemHead['user'];
	export type PullsListResponseItemHeadRepoOwner = PullsListResponseItemHead['repo']['owner'];
	export type IssuesListEventsForTimelineResponseItemActor = OctokitTypes.IssuesListEventsForTimelineResponseData[0]['actor'];
	export type PullsListReviewRequestsResponseTeamsItem = OctokitTypes.PullsListRequestedReviewersResponseData['teams'][0];
	export type PullsListResponseItemHeadRepoTemplateRepository = OctokitTypes.PullsListResponseData[0]['head']['repo']['template_repository'];
	export type ReposGetResponseCodeOfConduct = OctokitTypes.ReposGetResponseData['code_of_conduct'];
}