/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createBuilderClass, createLink } from '../base';
import { LatestReviewCommitResponse } from '../../../github/graphql';

import { RateLimitBuilder } from './rateLimitBuilder';

type Repository = NonNullable<LatestReviewCommitResponse['repository']>;
type PullRequest = Repository['pullRequest'];
type Reviews = PullRequest['reviews'];
type ReviewNode = Reviews['nodes'][0];
type Commit = ReviewNode['commit'];

export const LatestReviewCommitBuilder = createBuilderClass<LatestReviewCommitResponse>()({
	repository: createLink<Repository>()({
		pullRequest: createLink<PullRequest>()({
			reviews: createLink<Reviews>()({
				nodes: [
					createLink<ReviewNode>()({
						commit: createLink<Commit>()({
							oid: { default: 'abc' },
						}),
					}),
				],
			}),
		}),
	}),
	rateLimit: { linked: RateLimitBuilder },
});

export type LatestReviewCommitBuilder = InstanceType<typeof LatestReviewCommitBuilder>;
