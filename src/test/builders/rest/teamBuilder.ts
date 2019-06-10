import Octokit = require('@octokit/rest');
import { createBuilderClass } from '../base';

export type TeamUnion = Octokit.PullsListReviewRequestsResponseTeamsItem;

export const TeamBuilder = createBuilderClass<TeamUnion>()({
	id: {default: 1},
	node_id: {default: 'MDQ6VGVhbTE='},
	url: {default: 'https://api.github.com/teams/1'},
	name: {default: 'Justice League'},
	slug: {default: 'justice-league'},
	description: {default: 'A great team.'},
	privacy: {default: 'closed'},
	permission: {default: 'admin'},
	members_url: {default: 'https://api.github.com/teams/1/members{/member}'},
	repositories_url: {default: 'https://api.github.com/teams/1/repos'},
	parent: {default: null}
});

export type TeamBuilder = InstanceType<typeof TeamBuilder>;