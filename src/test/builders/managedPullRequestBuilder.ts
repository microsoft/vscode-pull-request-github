/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	PullRequestResponse as PullRequestGraphQL,
	TimelineEventsResponse as TimelineEventsGraphQL,
	LatestReviewCommitResponse as LatestReviewCommitGraphQL
} from '../../github/graphql';
import { PullRequestBuilder as PullRequestGraphQLBuilder } from './graphql/pullRequestBuilder';
import {
	PullRequestBuilder as PullRequestRESTBuilder,
	PullRequestUnion as PullRequestREST,
} from './rest/pullRequestBuilder';
import { TimelineEventsBuilder as TimelineEventsGraphQLBuilder } from './graphql/timelineEventsBuilder';
import { LatestReviewCommitBuilder as LatestReviewCommitGraphQLBuilder } from './graphql/latestReviewCommitBuilder';
import { RepoUnion as RepositoryREST, RepositoryBuilder as RepositoryRESTBuilder } from './rest/repoBuilder';
import { CombinedStatusBuilder as CombinedStatusRESTBuilder } from './rest/combinedStatusBuilder';
import { ReviewRequestsBuilder as ReviewRequestsRESTBuilder } from './rest/reviewRequestsBuilder';
import { createBuilderClass } from './base';
import { PullRequestChecks } from '../../github/interface';
import { OctokitCommon } from '../../github/common';

type ResponseFlavor<APIFlavor, GQL, RST> = APIFlavor extends 'graphql' ? GQL : RST;

export interface ManagedPullRequest<APIFlavor> {
	pullRequest: ResponseFlavor<APIFlavor, PullRequestGraphQL, PullRequestREST>;
	timelineEvents: ResponseFlavor<
		APIFlavor,
		TimelineEventsGraphQL,
		OctokitCommon.IssuesListEventsForTimelineResponseData[]
	>;
	latestReviewCommit: ResponseFlavor<APIFlavor, LatestReviewCommitGraphQL, any>;
	repositoryREST: RepositoryREST;
	combinedStatusREST: PullRequestChecks;
	reviewRequestsREST: OctokitCommon.PullsListRequestedReviewersResponseData;
}

export const ManagedGraphQLPullRequestBuilder = createBuilderClass<ManagedPullRequest<'graphql'>>()({
	pullRequest: { linked: PullRequestGraphQLBuilder },
	timelineEvents: { linked: TimelineEventsGraphQLBuilder },
	latestReviewCommit: { linked: LatestReviewCommitGraphQLBuilder },
	repositoryREST: { linked: RepositoryRESTBuilder },
	combinedStatusREST: { linked: CombinedStatusRESTBuilder },
	reviewRequestsREST: { linked: ReviewRequestsRESTBuilder },
});

export type ManagedGraphQLPullRequestBuilder = InstanceType<typeof ManagedGraphQLPullRequestBuilder>;

export const ManagedRESTPullRequestBuilder = createBuilderClass<ManagedPullRequest<'rest'>>()({
	pullRequest: { linked: PullRequestRESTBuilder },
	timelineEvents: { default: [] },
	latestReviewCommit: { default: 'abc' },
	repositoryREST: { linked: RepositoryRESTBuilder },
	combinedStatusREST: { linked: CombinedStatusRESTBuilder },
	reviewRequestsREST: { linked: ReviewRequestsRESTBuilder },
});

export type ManagedRESTPullRequestBuilder = InstanceType<typeof ManagedRESTPullRequestBuilder>;
