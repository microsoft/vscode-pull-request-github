/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as LRUCache from 'lru-cache';
import { PullRequestManager } from '../github/pullRequestManager';
import { IssueModel } from '../github/issueModel';

export const ISSUE_EXPRESSION = /(([^\s]+)\/([^\s]+))?#([0-9]+)/;
export const ISSUE_OR_URL_EXPRESSION = /(https?:\/\/github\.com\/(([^\s]+)\/([^\s]+))\/[^\s]+\/([0-9]+))|(([^\s]+)\/([^\s]+))?#([0-9]+)/;

export type ParsedIssue = { owner: string | undefined, name: string | undefined, issueNumber: number };

export function parseIssueExpressionOutput(output: RegExpMatchArray | null): ParsedIssue | undefined {
	if (!output) {
		return undefined;
	}
	const issue: ParsedIssue = { owner: undefined, name: undefined, issueNumber: 0 };
	if (output.length === 5) {
		issue.owner = output[2];
		issue.name = output[3];
		issue.issueNumber = parseInt(output[4]);
		return issue;
	} else if (output.length === 10) {
		issue.owner = output[3] || output[7];
		issue.name = output[4] || output[8];
		issue.issueNumber = parseInt(output[5] || output[9]);
		return issue;
	} else {
		return undefined;
	}
}

export async function getIssue(cache: LRUCache<string, IssueModel>, manager: PullRequestManager, issueValue: string, parsed: ParsedIssue): Promise<IssueModel | undefined> {
	if (cache.has(issueValue)) {
		return cache.get(issueValue);
	} else {
		let owner: string | undefined = undefined;
		let name: string | undefined = undefined;
		let issueNumber: number | undefined = undefined;
		const origin = await manager.getOrigin();
		if (!parsed) {
			const tryParse = parseIssueExpressionOutput(issueValue.match(ISSUE_OR_URL_EXPRESSION));
			if (tryParse && (!tryParse.name || !tryParse.owner)) {
				owner = origin.remote.owner;
				name = origin.remote.repositoryName;
			}
		} else {
			owner = parsed.owner ? parsed.owner : origin.remote.owner;
			name = parsed.name ? parsed.name : origin.remote.repositoryName;
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
