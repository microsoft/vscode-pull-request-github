import { UserBuilder } from './userBuilder';
import { RepositoryBuilder } from './repoBuilder';
import { createBuilderClass } from '../base';
import { OctokitCommon } from '../../../github/common';

type RefUnion = OctokitCommon.PullsListResponseItemHead & OctokitCommon.PullsListResponseItemBase;

export const RefBuilder = createBuilderClass<RefUnion>()({
	label: { default: 'octocat:new-feature' },
	ref: { default: 'new-feature' },
	user: { linked: UserBuilder },
	sha: { default: '0000000000000000000000000000000000000000' },
	// Must cast to any here to prevent recursive type.
	repo: { linked: <any>RepositoryBuilder },
});

export type RefBuilder = InstanceType<typeof RefBuilder>;
