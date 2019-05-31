import REST = require('@octokit/rest');

import { createBuilderClass } from '../base';

export const ReviewRequestsBuilder = createBuilderClass<REST.PullRequestsGetReviewRequestsResponse>()({
	users: {default: []},
	teams: {default: []},
});

export type ReviewRequestsBuilder = InstanceType<typeof ReviewRequestsBuilder>;