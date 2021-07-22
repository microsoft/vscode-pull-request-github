import { OctokitCommon } from '../../../github/common';

import { createBuilderClass } from '../base';

export const ReviewRequestsBuilder = createBuilderClass<OctokitCommon.PullsListRequestedReviewersResponseData>()({
	users: { default: [] },
	teams: { default: [] },
});

export type ReviewRequestsBuilder = InstanceType<typeof ReviewRequestsBuilder>;
