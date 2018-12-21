
/*---------------------------------------------------------------------------------------------
*  Copyright (c) Microsoft Corporation. All rights reserved.
*  Licensed under the MIT License. See License.txt in the project root for license information.
*--------------------------------------------------------------------------------------------*/

import gql from 'graphql-tag';
import { PullRequestModel } from '../pullRequestModel';

export const ALL_PULL_REQUEST_QUERY = gql `
query PullRequests($owner:String!, $name:String!) {
	repository(owner:$owner, name:$name) {
		pullRequests(last: 20 states:OPEN) {
			pageInfo {
				hasPreviousPage
				hasNextPage
				startCursor
				endCursor
			}
			edges {
				node {
					number
					body
					author {
						login
						avatarUrl
					}
					title
					url
					state
					createdAt
					updatedAt
					headRef {
						name
						repository {
							nameWithOwner
						}
						target {
							oid
						}
					}
					baseRef {
						name
						repository {
							nameWithOwner
						}
						target {
							oid
						}
					}
				}
			}
		}
	}
}
`;

export function resolvePullRequests(data) {
	return data.repository.pullRequests.edges.map(edge => {
		let item = {
			number: edge.node.number,
			title: edge.node.title,
			html_url: edge.node.url,
			clone_url: edge.node.url,
			user: {
				login: edge.node.author.login,
				avatar_url: edge.node.author.avatarUrl
			},
			labels: [],
			state: edge.node.state,
			merged: false,
			created_at: edge.node.createdAt,
			updated_at: edge.node.updatedAt,
			comments: 0,
			commits: 0,
			head: {
				label: '',
				user: null,
				repo: {
					clone_url: edge.node.headRef.repository.url

				},
				ref: edge.node.headRef.name,
				sha: edge.node.headRef.target.oid
			},
			base: {
				label: '',
				user: null,
				repo: {
					clone_url: edge.node.baseRef.repository.url
				},
				ref: edge.node.baseRef.name,
				sha: edge.node.baseRef.target.oid
			}
		};
		return new PullRequestModel(this, this.remote, item as any);
	}).reverse();
}