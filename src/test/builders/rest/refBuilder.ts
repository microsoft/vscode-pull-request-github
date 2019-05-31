import REST = require('@octokit/rest');
import { UserBuilder } from './userBuilder';
import { RepositoryBuilder } from './repoBuilder';
import { createBuilderClass } from '../base';

type RefUnion =
	REST.PullRequestsGetResponseHead &
	REST.PullRequestsGetResponseBase;

export const RefBuilder = createBuilderClass<RefUnion>()({
	label: {default: 'octocat:new-feature'},
	ref: {default: 'new-feature'},
	user: {linked: UserBuilder},
	sha: {default: '0000000000000000000000000000000000000000'},
	repo: {linked: RepositoryBuilder},
});

export type RefBuilder = InstanceType<typeof RefBuilder>;