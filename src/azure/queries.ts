/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ProviderListOptions, ProviderUnsupportedError } from '../providers/pullRequestProvider';

export interface QueryRepository {
	project: string;
	repository: string;
}

const identityPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function tokens(query: string): string[] {
	return [...query.matchAll(/(?:[^\s"]+|"[^"]*")+/g)].map(match => match[0].replace(/"/g, ''));
}

/**
 * Interprets the supported subset of the original category query syntax as Azure DevOps
 * search criteria. Qualifiers Azure cannot honor fail visibly instead of being ignored.
 */
export function azureListOptions(query: string, userId: string, repository: QueryRepository): ProviderListOptions {
	const options: ProviderListOptions = { status: 'all' };
	const identity = (value: string, qualifier: string) => {
		// eslint-disable-next-line no-template-curly-in-string
		if (value === '${user}' || value === '@me' || value === userId) {
			return userId;
		}
		if (identityPattern.test(value)) {
			return value;
		}
		throw new ProviderUnsupportedError(`The query value "${qualifier}:${value}" (use \${user} or an Azure DevOps identity ID)`);
	};
	for (const token of tokens(query)) {
		const separator = token.indexOf(':');
		if (separator < 1) {
			throw new ProviderUnsupportedError(`Free-text pull request search ("${token}")`);
		}
		const qualifier = token.slice(0, separator).toLowerCase();
		const value = token.slice(separator + 1);
		switch (qualifier) {
			case 'is':
			case 'state':
				if (value === 'pr' || value === 'pull-request') {
					break;
				}
				if (value !== 'open' && value !== 'closed' && value !== 'merged') {
					throw new ProviderUnsupportedError(`The query qualifier "${token}"`);
				}
				options.status = value;
				break;
			case 'type':
				if (value !== 'pr') {
					throw new ProviderUnsupportedError(`The query qualifier "${token}"`);
				}
				break;
			case 'repo':
				if (value.toLowerCase() !== `${repository.project}/${repository.repository}`.toLowerCase()) {
					throw new ProviderUnsupportedError(`Querying another repository ("${token}")`);
				}
				break;
			case 'author':
				options.creatorId = identity(value, qualifier);
				break;
			case 'review-requested':
			case 'reviewer':
				options.reviewerId = identity(value, qualifier);
				break;
			case 'base':
				options.targetBranch = value;
				break;
			case 'head':
				options.sourceBranch = value;
				break;
			default:
				throw new ProviderUnsupportedError(`The query qualifier "${token}"`);
		}
	}
	return options;
}
