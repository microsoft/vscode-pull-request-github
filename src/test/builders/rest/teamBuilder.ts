import { createBuilderClass } from '../base';
import { OctokitCommon } from '../../../github/common';

export type TeamUnion = OctokitCommon.PullsListReviewRequestsResponseTeamsItem;

export const TeamBuilder = createBuilderClass<TeamUnion>()({
	id: { default: 1 },
	node_id: { default: 'MDQ6VGVhbTE=' },
	url: { default: 'https://api.github.com/teams/1' },
	name: { default: 'Justice League' },
	slug: { default: 'justice-league' },
	description: { default: 'A great team.' },
	privacy: { default: 'closed' },
	permission: { default: 'admin' },
	members_url: { default: 'https://api.github.com/teams/1/members{/member}' },
	repositories_url: { default: 'https://api.github.com/teams/1/repos' },
	parent: { default: { test: 'test' } },
	html_url: { default: 'https://api.github.com/teams/1' }
});

export type TeamBuilder = InstanceType<typeof TeamBuilder>;