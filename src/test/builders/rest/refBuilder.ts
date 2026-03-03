/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { UserBuilder } from './userBuilder';
import { RepositoryBuilder } from './repoBuilder';
import { createBuilderClass } from '../base';
import { OctokitCommon } from '../../../github/common';

type RefUnion = OctokitCommon.PullsListResponseItemHead & OctokitCommon.PullsListResponseItemBase;

export const RefBuilder = createBuilderClass<NonNullable<RefUnion>>()({
	label: { default: 'octocat:new-feature' },
	ref: { default: 'new-feature' },
	user: { linked: UserBuilder },
	sha: { default: '0000000000000000000000000000000000000000' },
	// Must cast to any here to prevent recursive type.
	repo: { linked: <any>RepositoryBuilder },
});

// Variant where user is guaranteed non-null.
type NonNullUserRef = Omit<RefUnion, 'user'> & { user: NonNullable<RefUnion['user']> };

export const NonNullUserRefBuilder = createBuilderClass<NonNullUserRef>()({
	label: { default: 'octocat:new-feature' },
	ref: { default: 'new-feature' },
	user: { linked: UserBuilder }, // non-null guarantee
	sha: { default: '0000000000000000000000000000000000000000' },
	repo: { linked: <any>RepositoryBuilder },
});

export type RefBuilder = InstanceType<typeof RefBuilder>;
