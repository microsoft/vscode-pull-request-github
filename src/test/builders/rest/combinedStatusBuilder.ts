import Octokit = require('@octokit/rest');

import { createBuilderClass } from '../base';
import { RepositoryBuilder } from './repoBuilder';

export const StatusItemBuilder = createBuilderClass<Octokit.ReposGetCombinedStatusForRefResponseStatusesItem>()({
	url: {default: 'https://api.github.com/repos/octocat/Hello-World/statuses/0000000000000000000000000000000000000000'},
	avatar_url: {default: 'https://github.com/images/error/hubot_happy.gif'},
	id: {default: 1},
	node_id: {default: 'MDY6U3RhdHVzMQ=='},
	state: {default: 'success'},
	description: {default: 'Build has completed successfully'},
	target_url: {default: 'https://ci.example.com/1000/output'},
	context: {default: 'continuous-integration/jenkins'},
	created_at: {default: '2012-07-20T01:19:13Z'},
	updated_at: {default: '2012-07-20T01:19:13Z'}
});

export type StatusItemBuilder = InstanceType<typeof StatusItemBuilder>;

export const CombinedStatusBuilder = createBuilderClass<Octokit.ReposGetCombinedStatusForRefResponse>()({
	state: {default: 'success'},
	statuses: {default: []},
	sha: {default: '0000000000000000000000000000000000000000'},
	commit_url: {default: 'https://api.github.com/repos/octocat/Hello-World/commits/0000000000000000000000000000000000000000'},
	url: {default: 'https://api.github.com/repos/octocat/Hello-World/0000000000000000000000000000000000000000/status'},
	total_count: {default: 1},
	repository: {linked: RepositoryBuilder},
});

export type CombinedStatusBuilder = InstanceType<typeof CombinedStatusBuilder>;