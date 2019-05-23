import * as Octokit from '../../common/octokit';
import { Builder } from 'builder-pattern';

const templateRESTUser: Octokit.PullRequestsGetAllResponseItemUser = {
	id: 0,
	node_id: 'node0',
	login: 'octocat',
	avatar_url: 'https://avatars0.githubusercontent.com/u/583231?v=4',
	gravatar_id: '',
	url: 'https://api.github.com/users/octocat',
	html_url: 'https://github.com/octocat',
	followers_url: 'https://api.github.com/users/octocat/followers',
	following_url: 'https://api.github.com/users/octocat/following{/other_user}',
	gists_url: 'https://api.github.com/users/octocat/gists{/gist_id}',
	starred_url: 'https://api.github.com/users/octocat/starred{/owner}{/repo}',
	subscriptions_url: 'https://api.github.com/users/octocat/subscriptions',
	organizations_url: 'https://api.github.com/users/octocat/orgs',
	repos_url: 'https://api.github.com/users/octocat/repos',
	events_url: 'https://api.github.com/users/octocat/events{/privacy}',
	received_events_url: 'https://api.github.com/users/octocat/received_events',
	type: 'User',
	site_admin: false
};

export function createRESTUser() {
	return Builder(templateRESTUser);
}