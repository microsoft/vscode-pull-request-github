import * as  OctokitTypes from '@octokit/types';

import { UserBuilder } from './userBuilder';
import { createBuilderClass } from '../base';

export const TimelineEventItemBuilder = createBuilderClass<OctokitTypes.IssuesListEventsForTimelineResponseData[0]>()({
	id: { default: 1 },
	node_id: { default: 'MDEwOklzc3VlRXZlbnQx' },
	url: { default: 'https://api.github.com/repos/octocat/Hello-World/issues/events/1' },
	actor: { linked: UserBuilder },
	event: { default: 'closed' },
	commit_id: { default: '0000000000000000000000000000000000000000' },
	commit_url: { default: 'https://api.github.com/repos/octocat/Hello-World/commits/0000000000000000000000000000000000000000' },
	created_at: { default: '2019-01-01T10:00:00Z' },
});

export type TimelineEventItemBuilder = InstanceType<typeof TimelineEventItemBuilder>;