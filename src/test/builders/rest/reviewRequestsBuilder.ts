import { Octokit } from '@octokit/rest';

import { createBuilderClass } from '../base';

export const ReviewRequestsBuilder = createBuilderClass<Octokit.PullsListReviewRequestsResponse>()({
	users: { default: [] },
	teams: { default: [] },
});

export type ReviewRequestsBuilder = InstanceType<typeof ReviewRequestsBuilder>;