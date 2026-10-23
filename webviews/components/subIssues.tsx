/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import { issuescon, passIcon } from './icon';
import { Avatar } from './user';
import { GithubItemStateEnum, SubIssueReference } from '../../src/github/interface';

export function SubIssues({ subIssues, owner, repo }: { subIssues: SubIssueReference[]; owner: string; repo: string }) {
	return (
		<div id="sub-issues" className="sub-issues">
			<div className="sub-issues-header">Sub-issues</div>
			{subIssues.map(subIssue => {
				const isOpen = subIssue.state === GithubItemStateEnum.Open;
				const isSameRepo = subIssue.owner === owner && subIssue.repo === repo;
				const numberLabel = isSameRepo ? `#${subIssue.number}` : `${subIssue.owner}/${subIssue.repo}#${subIssue.number}`;
				return (
					<a key={subIssue.id} className="issue-item sub-issue-row" href={subIssue.url} title={`${numberLabel} ${subIssue.title}`}>
						<span className={`section-icon ${isOpen ? 'issue-open' : 'issue-closed'}`}>
							{isOpen ? issuescon : passIcon}
						</span>
						<span className="issue-item-text">{subIssue.title}</span>
						<span className="sub-issue-number">{numberLabel}</span>
						<span className="sub-issue-assignees">
							{subIssue.assignees.map(assignee => <Avatar key={assignee.login} for={assignee} link={false} />)}
						</span>
					</a>
				);
			})}
		</div>
	);
}
