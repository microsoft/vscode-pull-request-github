/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import { chevronDownIcon, circleFilledIcon, gitMergeIcon, gitPullRequestDraftIcon, layersIcon, passIcon, skipIcon } from './icon';
import { GithubItemStateEnum, PullRequestMergeability, PullRequestStack as Stack } from '../../src/github/interface';
import { PullRequest } from '../../src/github/views';
import PullRequestContext from '../common/context';

function getReadiness(entry: Stack['pullRequests'][number], stack: Stack): { icon: JSX.Element; label: string; kind: string } {
	if (entry.state === GithubItemStateEnum.Merged) {
		return { icon: gitMergeIcon, label: 'Already merged', kind: 'merged' };
	}
	if (entry.state === GithubItemStateEnum.Closed) {
		return { icon: skipIcon, label: 'Closed pull request cannot be merged', kind: 'blocked' };
	}
	if (entry.isDraft) {
		return { icon: gitPullRequestDraftIcon, label: 'Draft pull request cannot be merged', kind: 'draft' };
	}
	switch (entry.mergeable) {
		case PullRequestMergeability.Mergeable:
			if (stack.pullRequests.some(below => below.position < entry.position && below.state === GithubItemStateEnum.Open
				&& below.mergeable === PullRequestMergeability.Behind)) {
				return { icon: circleFilledIcon, label: 'A pull request below is behind its base', kind: 'waiting' };
			}
			return { icon: entry.position > stack.position ? circleFilledIcon : passIcon, label: 'Ready to merge', kind: 'ready' };
		case PullRequestMergeability.Conflict:
			return { icon: circleFilledIcon, label: 'Merge conflicts', kind: 'waiting' };
		case PullRequestMergeability.NotMergeable:
			return { icon: circleFilledIcon, label: 'Merge requirements not met', kind: 'waiting' };
		case PullRequestMergeability.Behind:
			return { icon: circleFilledIcon, label: 'Branch is behind its base', kind: 'waiting' };
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
	const { unstackAll, updateStack } = React.useContext(PullRequestContext);
	const [busy, setBusy] = React.useState(false);
	const [error, setError] = React.useState<string | undefined>();
	const [updating, setUpdating] = React.useState(false);
	const [updateError, setUpdateError] = React.useState<string | undefined>();
	const { stack } = pr;
	if (!stack) {
		return null;
	}
	const openBelow = stack.pullRequests.filter(entry => entry.position < stack.position && entry.state === GithubItemStateEnum.Open).length;
	const canUnstack = pr.hasWritePermission && stack.pullRequests.some(entry => entry.state !== GithubItemStateEnum.Merged);
	const canUpdate = !!pr.canUpdateStack && pr.stackLoaded !== false && !pr.stackLoadError;

	const unstack = async () => {
		try {
			setBusy(true);
			setError(undefined);
			setUpdateError(undefined);
			await unstackAll();
		} catch (unstackError) {
			setError(`Unable to unstack pull requests: ${unstackError instanceof Error ? unstackError.message || unstackError.name : String(unstackError)}`);
		} finally {
			setBusy(false);
		}
	};

	const update = async () => {
		try {
			setUpdating(true);
			setUpdateError(undefined);
			setError(undefined);
			await updateStack();
		} catch (updateFailure) {
			setUpdateError(`Unable to update the stack: ${updateFailure instanceof Error ? updateFailure.message || updateFailure.name : String(updateFailure)}`);
		} finally {
			setUpdating(false);
		}
	};

	return (
		<details className={`stack-section${canUnstack || canUpdate ? ' has-actions' : ''}`} id="pull-request-stack" open>
			<summary className="status-item">
				{layersIcon}
				<span className="stack-heading-text">
					<strong>Pull request stack</strong>
					<span className="stack-description">
						{pr.state === GithubItemStateEnum.Open && openBelow > 0
							? `Merging this pull request will also merge ${openBelow} pull request${openBelow === 1 ? '' : 's'} below it.`
							: `${stack.size} pull requests in this stack.`}
					</span>
				</span>
				<span className="stack-chevron">{chevronDownIcon}</span>
			</summary>
			{canUnstack || canUpdate ? <div className="stack-actions">
				{canUpdate ? <button className="secondary" type="button" title="Rebase and push all pull requests in this stack"
					disabled={busy || updating || !!pr.stackMergeStatus} onClick={update}>
					{updating ? 'Updating...' : 'Update stack'}
				</button> : null}
				{canUnstack ? <button className="secondary" type="button" title="Unstack all eligible pull requests"
					disabled={busy || updating || !!pr.stackMergeStatus} onClick={unstack}>
					{busy ? 'Unstacking...' : 'Unstack all'}
				</button> : null}
			</div> : null}
			{error || updateError ? <div className="stack-action-error" role="alert">{error ?? updateError}</div> : null}
			<ol className="stack-entries" aria-label={`Pull requests merging down into ${stack.base}`}>
				{[...stack.pullRequests].reverse().map(entry => {
					const current = entry.number === pr.number;
					const readiness = getReadiness(entry, stack);

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
