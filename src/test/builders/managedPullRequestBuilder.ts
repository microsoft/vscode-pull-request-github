import {
	PullRequestResponse as PullRequestGraphQL,
	TimelineEventsResponse as TimelineEventsGraphQL
} from '../../github/graphql';
import {
	ReposGetCombinedStatusForRefResponse as CombinedStatusREST,
	PullRequestsGetReviewRequestsResponse as ReviewRequestsREST,
	IssuesGetEventsTimelineResponseItem as TimelineEventREST,
} from '@octokit/rest';

import { PullRequestBuilder as PullRequestGraphQLBuilder } from './graphql/pullRequestBuilder';
import { PullRequestBuilder as PullRequestRESTBuilder, PullRequestUnion as PullRequestREST } from './rest/pullRequestBuilder';
import { TimelineEventsBuilder as TimelineEventsGraphQLBuilder } from './graphql/timelineEventsBuilder';
import { RepoUnion as RepositoryREST, RepositoryBuilder as RepositoryRESTBuilder } from './rest/repoBuilder';
import { TimelineEventItemBuilder as TimelineEventRESTBuilder } from './rest/timelineEventItemBuilder';
import { CombinedStatusBuilder as CombinedStatusRESTBuilder } from './rest/combinedStatusBuilder';
import { ReviewRequestsBuilder as ReviewRequestsRESTBuilder } from './rest/reviewRequestsBuilder';

type ResponseFlavor<APIFlavor, GQL, RST> = APIFlavor extends 'graphql' ? GQL : RST;

export interface ManagedPullRequest<APIFlavor> {
	pr: ResponseFlavor<APIFlavor, PullRequestGraphQL, PullRequestREST>;
	timelineEvents: ResponseFlavor<APIFlavor, TimelineEventsGraphQL, TimelineEventREST[]>;
	repositoryREST: RepositoryREST;
	combinedStatusREST: CombinedStatusREST;
	reviewRequestsREST: ReviewRequestsREST;
}

abstract class BaseManagedPullRequestBuilder<APIFlavor extends 'graphql' | 'rest'> {
	protected _underConstruction: Partial<ManagedPullRequest<APIFlavor>>;

	repository(block: (builder: RepositoryRESTBuilder) => any) {
		const builder = new RepositoryRESTBuilder();
		block(builder);
		this._underConstruction.repositoryREST = builder.build();
		return this;
	}

	combinedStatus(block: (builder: CombinedStatusRESTBuilder) => any) {
		const builder = new CombinedStatusRESTBuilder();
		block(builder);
		this._underConstruction.combinedStatusREST = builder.build();
		return this;
	}

	reviewRequests(block: (builder: ReviewRequestsRESTBuilder) => any) {
		const builder = new ReviewRequestsRESTBuilder();
		block(builder);
		this._underConstruction.reviewRequestsREST = builder.build();
		return this;
	}

	build(): ManagedPullRequest<APIFlavor> {
		return this._underConstruction as ManagedPullRequest<APIFlavor>;
	}
}

export class ManagedGraphQLPullRequestBuilder extends BaseManagedPullRequestBuilder<'graphql'> {
	pullRequest(block: (builder: PullRequestGraphQLBuilder) => any) {
		const builder = new PullRequestGraphQLBuilder();
		block(builder);
		this._underConstruction.pr = builder.build();
		return this;
	}

	timelineEvents(block: (builder: TimelineEventsGraphQLBuilder) => any) {
		const builder = new TimelineEventsGraphQLBuilder();
		block(builder);
		this._underConstruction.timelineEvents = builder.build();
		return this;
	}
}

export class ManagedRESTPullRequestBuilder extends BaseManagedPullRequestBuilder<'rest'> {
	pullRequest(block: (builder: PullRequestRESTBuilder) => any) {
		const builder = new PullRequestRESTBuilder();
		block(builder);
		this._underConstruction.pr = builder.build();
		return this;
	}

	timelineEvents(blocks: ((builder: TimelineEventRESTBuilder) => any)[]) {
		this._underConstruction.timelineEvents = [];
		for (const block of blocks) {
			const builder = new TimelineEventRESTBuilder();
			block(builder);
			this._underConstruction.timelineEvents.push(builder.build());
		}
		return this;
	}
}