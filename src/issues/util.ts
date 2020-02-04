/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as LRUCache from 'lru-cache';
import { PullRequestManager } from '../github/pullRequestManager';
import { IssueModel } from '../github/issueModel';

export const ISSUE_EXPRESSION = /(([^\s]+)\/([^\s]+))?#([0-9]+)/;

export type ParsedIssue = { owner: string | undefined, name: string | undefined, issueNumber: number };

export async function getIssue(cache: LRUCache<string, IssueModel>, manager: PullRequestManager, issueValue: string, parsed: ParsedIssue): Promise<IssueModel | undefined> {
	if (cache.has(issueValue)) {
		return cache.get(issueValue);
	} else {
		let owner: string | undefined = undefined;
		let name: string | undefined = undefined;
		let issueNumber: number | undefined = undefined;
		if (!parsed) {
			const repoMatch = issueValue.match(ISSUE_EXPRESSION);
			if (repoMatch && repoMatch.length === 5) {
				owner = manager.origin.remote.owner;
				name = manager.origin.remote.repositoryName;
				issueNumber = parseInt(repoMatch[4]);

				if (repoMatch[2] && repoMatch[3]) {
					owner = repoMatch[2];
					name = repoMatch[3];
				}
			}
		} else {
			owner = parsed.owner ? parsed.owner : manager.origin.remote.owner;
			name = parsed.name ? parsed.name : manager.origin.remote.repositoryName;
			issueNumber = parsed.issueNumber;
		}

		if (owner && name && (issueNumber !== undefined)) {

			let issue = await manager.resolveIssue(owner, name, issueNumber);
			if (!issue) {
				issue = await manager.resolvePullRequest(owner, name, issueNumber);
			}
			if (issue) {
				cache.set(issueValue, issue);
			}

			return issue;
		}
	}
	return undefined;
}
