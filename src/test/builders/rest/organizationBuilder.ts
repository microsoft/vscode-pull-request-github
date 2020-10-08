import { createBuilderClass } from '../base';
import { OctokitCommon } from '../../../github/common';

export const OrganizationBuilder = createBuilderClass<OctokitCommon.ReposGetResponseOrganization>()({
	login: { default: 'octocat' },
	id: { default: 1 },
	node_id: { default: 'MDQ6VXNlcjE=' },
	avatar_url: { default: 'https://github.com/images/error/octocat_happy.gif' },
	gravatar_id: { default: '' },
	url: { default: 'https://api.github.com/users/octocat' },
	html_url: { default: 'https://github.com/octocat' },
	followers_url: { default: 'https://api.github.com/users/octocat/followers' },
	following_url: { default: 'https://api.github.com/users/octocat/following{/other_user}' },
	gists_url: { default: 'https://api.github.com/users/octocat/gists{/gist_id}' },
	starred_url: { default: 'https://api.github.com/users/octocat/starred{/owner}{/repo}' },
	subscriptions_url: { default: 'https://api.github.com/users/octocat/subscriptions' },
	organizations_url: { default: 'https://api.github.com/users/octocat/orgs' },
	repos_url: { default: 'https://api.github.com/users/octocat/repos' },
	events_url: { default: 'https://api.github.com/users/octocat/events{/privacy}' },
	received_events_url: { default: 'https://api.github.com/users/octocat/received_events' },
	type: { default: 'Organization' },
	site_admin: { default: false },
});

export type OrganizationBuilder = InstanceType<typeof OrganizationBuilder>;