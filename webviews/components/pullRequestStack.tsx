/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import { checkIcon, chevronDownIcon, circleFilledIcon, closeIcon, layersIcon, warningIcon } from './icon';
import { GithubItemStateEnum, PullRequestMergeability, PullRequestStack as Stack } from '../../src/github/interface';
import { PullRequest } from '../../src/github/views';

function getReadiness(entry: Stack['pullRequests'][number]): { icon: JSX.Element; label: string; kind: string } {
	if (entry.state === GithubItemStateEnum.Merged) {
		return { icon: checkIcon, label: 'Already merged', kind: 'ready' };
	}
	if (entry.state === GithubItemStateEnum.Closed) {
		return { icon: closeIcon, label: 'Closed pull request cannot be merged', kind: 'blocked' };
	}
	if (entry.isDraft) {
		return { icon: warningIcon, label: 'Draft pull request cannot be merged', kind: 'waiting' };
	}
	switch (entry.mergeable) {
		case PullRequestMergeability.Mergeable:
			return { icon: checkIcon, label: 'Ready to merge', kind: 'ready' };
		case PullRequestMergeability.Conflict:
			return { icon: closeIcon, label: 'Merge conflicts', kind: 'blocked' };
		case PullRequestMergeability.NotMergeable:
			return { icon: closeIcon, label: 'Merge requirements not met', kind: 'blocked' };
		case PullRequestMergeability.Behind:
			return { icon: warningIcon, label: 'Branch is behind its base', kind: 'waiting' };
		default:
			return { icon: circleFilledIcon, label: 'Mergeability is being checked', kind: 'waiting' };
	}
}

export const StackBadge = ({ stack }: { stack?: Stack }) => stack ? (
	<a className="stack-badge" href="#pull-request-stack" aria-label={`Pull request ${stack.position} of ${stack.size} in stack`} title={`View pull request stack (${stack.position} of ${stack.size})`}>
		{layersIcon}
		<span>{stack.position}/{stack.size}</span>
	</a>
) : null;

export const StackSection = ({ pr }: { pr: PullRequest }) => {
	const { stack } = pr;
	if (!stack) {
		return null;
	}
	const openBelow = stack.pullRequests.filter(entry => entry.position < stack.position && entry.state === GithubItemStateEnum.Open).length;

	return (
		<details className="stack-section" id="pull-request-stack" open>
			<summary className="status-item">
				{layersIcon}
				<span>
					<strong>Pull request stack</strong>
					<span className="stack-description">
						{pr.state === GithubItemStateEnum.Open && openBelow > 0
							? `Merging this pull request will also merge ${openBelow} pull request${openBelow === 1 ? '' : 's'} below it.`
							: `${stack.size} pull requests in this stack.`}
					</span>
				</span>
				<span className="stack-chevron">{chevronDownIcon}</span>
			</summary>
			<ol className="stack-entries" aria-label={`Pull requests merging down into ${stack.base}`}>
				{[...stack.pullRequests].reverse().map(entry => {
					const current = entry.number === pr.number;
					const readiness = getReadiness(entry);

					return <li key={entry.number} className={`stack-entry${current ? ' current' : ''}`} aria-current={current ? 'step' : undefined}>
						<span className={`stack-entry-readiness ${readiness.kind}`} role="img" aria-label={readiness.label} title={readiness.label}>{readiness.icon}</span>
						<span className="stack-entry-details">
							{current ? <strong>{entry.title}</strong> : <a href={entry.url}>{entry.title}</a>}
							<span className="stack-entry-meta">#{entry.number} - {entry.head}</span>
						</span>
					</li>;
				})}
				<li className="stack-base">
					<span className="stack-base-marker" aria-hidden="true" />
					<code className="branch-tag">{stack.base}</code>
				</li>
			</ol>
		</details>
	);
};
