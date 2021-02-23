import { UserBuilder } from './userBuilder';
import { createBuilderClass } from '../base';
import { OctokitCommon } from '../../../github/common';

export const TimelineEventItemBuilder = createBuilderClass<OctokitCommon.IssuesListEventsForTimelineResponseData[0]>()({
	id: { default: 1 },
	node_id: { default: 'MDEwOklzc3VlRXZlbnQx' },
	url: { default: 'https://api.github.com/repos/octocat/Hello-World/issues/events/1' },
	actor: { linked: UserBuilder },
	event: { default: 'closed' },
	commit_id: { default: '0000000000000000000000000000000000000000' },
	commit_url: {
		default: 'https://api.github.com/repos/octocat/Hello-World/commits/0000000000000000000000000000000000000000',
	},
	created_at: { default: '2019-01-01T10:00:00Z' },
	sha: { default: '00000000000000000000000000000000' },
	author_association: { default: 'COLLABORATOR' },
	body: { default: '' },
	body_html: { default: '' },
	body_text: { default: '' },
	html_url: { default: 'https://github.com/octocat' },
	issue_url: { default: 'https://github.com/octocat/issues/1' },
	lock_reason: { default: '' },
	message: { default: '' },
	pull_request_url: { default: 'https://github.com/octocat/pulls/1' },
	state: { default: '' },
	submitted_at: { default: '' },
	updated_at: { default: '' },
});

export type TimelineEventItemBuilder = InstanceType<typeof TimelineEventItemBuilder>;
