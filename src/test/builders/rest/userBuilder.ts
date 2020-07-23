import { createBuilderClass } from '../base';
import { OctokitCommon } from '../../../github/common';

type UserUnion =
	OctokitCommon.PullsListResponseItemUser |
	OctokitCommon.PullsListResponseItemAssignee |
	OctokitCommon.PullsListResponseItemAssigneesItem |
	OctokitCommon.PullsListResponseItemRequestedReviewersItem |
	OctokitCommon.PullsListResponseItemBaseUser |
	OctokitCommon.PullsListResponseItemBaseRepoOwner |
	OctokitCommon.PullsListResponseItemHeadUser |
	OctokitCommon.PullsListResponseItemHeadRepoOwner |
	OctokitCommon.IssuesListEventsForTimelineResponseItemActor;

export const UserBuilder = createBuilderClass<UserUnion>()({
	id: { default: 0 },
	node_id: { default: 'node0' },
	login: { default: 'octocat' },
	avatar_url: { default: 'https://avatars0.githubusercontent.com/u/583231?v=4' },
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
	type: { default: 'User' },
	site_admin: { default: false }
});

export type UserBuilder = InstanceType<typeof UserBuilder>;