import {
	PullRequestResponse as PullRequestGraphQL,
	TimelineEventsResponse as TimelineEventsGraphQL,
} from '../../github/graphql';
import {
	PullsListRequestedReviewersResponseData as ReviewRequestsREST,
	IssuesListEventsForTimelineResponseData as TimelineEventREST,
} from '@octokit/types';

import { PullRequestUnion as PullRequestREST } from './rest/pullRequestBuilder';
import { RepoUnion as RepositoryREST } from './rest/repoBuilder';
import { PullRequestChecks } from '../../github/interface';

type ResponseFlavor<APIFlavor, GQL, RST> = APIFlavor extends 'graphql' ? GQL : RST;

export interface ManagedPullRequest<APIFlavor> {
	pullRequest: ResponseFlavor<APIFlavor, PullRequestGraphQL, PullRequestREST>;
	timelineEvents: ResponseFlavor<APIFlavor, TimelineEventsGraphQL, TimelineEventREST[]>;
	repositoryREST: RepositoryREST;
	combinedStatusREST: PullRequestChecks;
	reviewRequestsREST: ReviewRequestsREST;
}
