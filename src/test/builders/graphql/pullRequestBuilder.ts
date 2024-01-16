/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createBuilderClass, createLink } from '../base';
import { BaseRefRepository, DefaultCommitMessage, DefaultCommitTitle, PullRequestResponse, Ref, RefRepository } from '../../../github/graphql';

import { RateLimitBuilder } from './rateLimitBuilder';

const RefRepositoryBuilder = createBuilderClass<RefRepository>()({
	isInOrganization: { default: false },
	owner: createLink<RefRepository['owner']>()({
		login: { default: 'me' },
	}),
	url: { default: 'https://github.com/owner/repo' },
});

const BaseRefRepositoryBuilder = createBuilderClass<BaseRefRepository>()({
	isInOrganization: { default: false },
	owner: createLink<RefRepository['owner']>()({
		login: { default: 'me' },
	}),
	url: { default: 'https://github.com/owner/repo' },
	mergeCommitMessage: { default: DefaultCommitMessage.commitMessages },
	mergeCommitTitle: { default: DefaultCommitTitle.mergeMessage },
	squashMergeCommitMessage: { default: DefaultCommitMessage.prBody },
	squashMergeCommitTitle: { default: DefaultCommitTitle.prTitle },
});

const RefBuilder = createBuilderClass<Ref>()({
	name: { default: 'main' },
	repository: { linked: RefRepositoryBuilder },
	target: createLink<Ref['target']>()({
		oid: { default: '0000000000000000000000000000000000000000' },
	}),
});

type Repository = PullRequestResponse['repository'];
type PullRequest = Repository['pullRequest'];
type Author = PullRequest['author'];
type AssigneesConn = PullRequest['assignees'];
type CommitsConn = PullRequest['commits'];
type LabelConn = PullRequest['labels'];

export const PullRequestBuilder = createBuilderClass<PullRequestResponse>()({
	repository: createLink<Repository>()({
		pullRequest: createLink<PullRequest>()({
			id: { default: 'pr0' },
			databaseId: { default: 1234 },
			number: { default: 1347 },
			url: { default: 'https://github.com/owner/repo/pulls/1347' },
			state: { default: 'OPEN' },
			body: { default: '**markdown**' },
			bodyHTML: { default: '<h1>markdown</h1>' },
			title: { default: 'plz merge' },
			titleHTML: { default: 'plz merge' },
			assignees: createLink<AssigneesConn>()({
				nodes: {
					default: [
						{
							avatarUrl: '',
							email: '',
							login: 'me',
							url: 'https://github.com/me',
							id: '123'
						},
					],
				},
			}),
			author: createLink<Author>()({
				login: { default: 'me' },
				url: { default: 'https://github.com/me' },
				avatarUrl: { default: 'https://avatars3.githubusercontent.com/u/17565?v=4' },
				id: { default: '123' },
			}),
			createdAt: { default: '2019-01-01T10:00:00Z' },
			updatedAt: { default: '2019-01-01T11:00:00Z' },
			headRef: { linked: RefBuilder },
			headRefName: { default: 'pr-branch' },
			headRefOid: { default: '0000000000000000000000000000000000000000' },
			headRepository: { linked: RefRepositoryBuilder },
			baseRef: { linked: RefBuilder },
			baseRefName: { default: 'main' },
			baseRefOid: { default: '0000000000000000000000000000000000000000' },
			baseRepository: { linked: BaseRefRepositoryBuilder },
			labels: createLink<LabelConn>()({
				nodes: { default: [] },
			}),
			merged: { default: false },
			mergeable: { default: 'MERGEABLE' },
			mergeStateStatus: { default: 'CLEAN' },
			isDraft: { default: false },
			suggestedReviewers: { default: [] },
			viewerCanEnableAutoMerge: { default: false },
			viewerCanDisableAutoMerge: { default: false },
			viewerCanUpdate: { default: false },
			commits: createLink<CommitsConn>()({
				nodes: {
					default: [
						{ commit: { message: 'commit 1' } },
					]
				}
			})
		})
	}),
	rateLimit: { linked: RateLimitBuilder },
});

export type PullRequestBuilder = InstanceType<typeof PullRequestBuilder>;
