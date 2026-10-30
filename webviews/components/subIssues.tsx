/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import { issuescon, passIcon } from './icon';
import { Avatar } from './user';
import { GithubItemStateEnum, SubIssueReference } from '../../src/github/interface';

function issueNumberLabel(ref: SubIssueReference, owner: string, repo: string): string {
	const isSameRepo = ref.owner.toLowerCase() === owner.toLowerCase() && ref.repo.toLowerCase() === repo.toLowerCase();
	return isSameRepo ? `#${ref.number}` : `${ref.owner}/${ref.repo}#${ref.number}`;
}

export function SubIssues({ subIssues, owner, repo }: { subIssues: SubIssueReference[]; owner: string; repo: string }) {
	return (
		<div id="sub-issues" className="sub-issues">
			<div className="sub-issues-header">Sub-issues</div>
			{subIssues.map(subIssue => {
				const isOpen = subIssue.state === GithubItemStateEnum.Open;
				const numberLabel = issueNumberLabel(subIssue, owner, repo);
				return (
					<a key={subIssue.id} className="issue-item sub-issue-row" href={subIssue.url} title={`${numberLabel} ${subIssue.title}`}>
						<span className={`section-icon ${isOpen ? 'issue-open' : 'issue-closed'}`} role="img" aria-label={isOpen ? 'Open' : 'Closed'} title={isOpen ? 'Open' : 'Closed'}>
							{isOpen ? issuescon : passIcon}
						</span>
						<span className="issue-item-text">{subIssue.title}</span>
						<span className="sub-issue-number">{numberLabel}</span>
						<span className="sub-issue-assignees">
							{subIssue.assignees.map(assignee => (
								<span key={assignee.login} className="sub-issue-assignee" role="img" aria-label={assignee.login} title={assignee.login}>
									<Avatar for={assignee} link={false} />
								</span>
							))}
						</span>
					</a>
				);
			})}
		</div>
	);
}

export function ParentIssue({ parentIssue, owner, repo }: { parentIssue: SubIssueReference; owner: string; repo: string }) {
	const label = issueNumberLabel(parentIssue, owner, repo);
	return (
		<div id="parent-issue" className="parent-issue">
			Part of <a className="parent-issue-link" href={parentIssue.url} title={`${label} ${parentIssue.title}`}>{label} - {parentIssue.title}</a>
		</div>
	);
}
