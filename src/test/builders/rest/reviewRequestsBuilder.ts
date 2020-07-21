import * as OctokitTypes from '@octokit/types';

import { createBuilderClass } from '../base';

export const ReviewRequestsBuilder = createBuilderClass<OctokitTypes.PullsListRequestedReviewersResponseData>()({
	users: { default: [] },
	teams: { default: [] },
});

export type ReviewRequestsBuilder = InstanceType<typeof ReviewRequestsBuilder>;