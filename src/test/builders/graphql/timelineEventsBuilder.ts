import { createBuilderClass, createLink } from '../base';
import { TimelineEventsResponse } from '../../../github/graphql';

import { RateLimitBuilder } from './rateLimitBuilder';

type Repository = TimelineEventsResponse['repository'];
type PullRequest = Repository['pullRequest'];
type TimelineConn = PullRequest['timelineItems'];

export const TimelineEventsBuilder = createBuilderClass<TimelineEventsResponse>()({
	repository: createLink<Repository>()({
		pullRequest: createLink<PullRequest>()({
			timelineItems: createLink<TimelineConn>()({
				nodes: { default: [] },
			}),
		}),
	}),
	rateLimit: { linked: RateLimitBuilder },
});

export type TimelineEventsBuilder = InstanceType<typeof TimelineEventsBuilder>;