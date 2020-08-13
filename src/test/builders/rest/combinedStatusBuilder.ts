
import { createBuilderClass } from '../base';
import { OctokitCommon } from '../../../github/common';
import { PullRequestChecks } from '../../../github/interface';

export const StatusItemBuilder = createBuilderClass<OctokitCommon.ReposGetCombinedStatusForRefResponseStatusesItem>()({
	url: { default: 'https://api.github.com/repos/octocat/Hello-World/statuses/0000000000000000000000000000000000000000' },
	avatar_url: { default: 'https://github.com/images/error/hubot_happy.gif' },
	id: { default: 1 },
	node_id: { default: 'MDY6U3RhdHVzMQ==' },
	state: { default: 'success' },
	description: { default: 'Build has completed successfully' },
	target_url: { default: 'https://ci.example.com/1000/output' },
	context: { default: 'continuous-integration/jenkins' },
	created_at: { default: '2012-07-20T01:19:13Z' },
	updated_at: { default: '2012-07-20T01:19:13Z' }
});

export type StatusItemBuilder = InstanceType<typeof StatusItemBuilder>;

export const CombinedStatusBuilder = createBuilderClass<PullRequestChecks>()({
	state: { default: 'success' },
	statuses: { default: [] }
});

export type CombinedStatusBuilder = InstanceType<typeof CombinedStatusBuilder>;