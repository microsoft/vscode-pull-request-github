/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import { chevronDownIcon, circleFilledIcon, closeIcon, gitMergeIcon, gitPullRequestDraftIcon, layersIcon, passIcon, skipIcon } from './icon';
import { GithubItemStateEnum, hasConflictingStackEntry, PullRequestMergeability, PullRequestStack as Stack } from '../../src/github/interface';
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
	// Updating the stack brings a pull request up to date with its base, so being behind does not make one without
	// conflicts look blocked. Pull requests above the current one are shown as a dot rather than a check.
	const noConflictsIcon = entry.position > stack.position ? circleFilledIcon : passIcon;
	switch (entry.mergeable) {
		case PullRequestMergeability.Mergeable:
			if (stack.pullRequests.some(below => below.position < entry.position && below.state === GithubItemStateEnum.Open
				&& below.mergeable === PullRequestMergeability.Behind)) {
				return { icon: noConflictsIcon, label: 'No conflicts, but a pull request below is behind its base', kind: 'ready' };
			}
			return { icon: noConflictsIcon, label: 'Ready to merge', kind: 'ready' };
		case PullRequestMergeability.Conflict:
			return { icon: closeIcon, label: 'Merge conflicts', kind: 'conflict' };
		case PullRequestMergeability.NotMergeable:
			return { icon: circleFilledIcon, label: 'Merge requirements not met', kind: 'waiting' };
		case PullRequestMergeability.Behind:
			return { icon: noConflictsIcon, label: 'No conflicts, but the branch is behind its base', kind: 'ready' };
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

export function canUpdatePullRequestStack(pr: PullRequest): boolean {
	return !!pr.stack && !!pr.canUpdateStack && pr.stackLoaded !== false && !pr.stackLoadError;
}

/** Whether any open pull request in the stack, including this one, has conflicts that updating the stack resolves. */
export function stackHasConflicts(pr: PullRequest): boolean {
	return pr.mergeable === PullRequestMergeability.Conflict || hasConflictingStackEntry(pr.stack);
}

/** Stack actions share their progress and errors with every control that can trigger them. */
export interface StackActions {
	unstacking: boolean;
	updating: boolean;
	error?: string;
	unstack(): Promise<void>;
	update(): Promise<void>;
}

export function useStackActions(): StackActions {
	const { unstackAll, updateStack } = React.useContext(PullRequestContext);
	const [unstacking, setUnstacking] = React.useState(false);
	const [updating, setUpdating] = React.useState(false);
	const [error, setError] = React.useState<string | undefined>();

	const unstack = async () => {
		try {
			setUnstacking(true);
			setError(undefined);
			await unstackAll();
		} catch (unstackError) {
			setError(`Unable to unstack pull requests: ${unstackError instanceof Error ? unstackError.message || unstackError.name : String(unstackError)}`);
		} finally {
			setUnstacking(false);
		}
	};

	const update = async () => {
		try {
			setUpdating(true);
			setError(undefined);
			await updateStack();
		} catch (updateFailure) {
			setError(`Unable to update the stack: ${updateFailure instanceof Error ? updateFailure.message || updateFailure.name : String(updateFailure)}`);
		} finally {
			setUpdating(false);
		}
	};

	return { unstacking, updating, error, unstack, update };
}

export const StackSection = ({ pr, actions }: { pr: PullRequest; actions: StackActions }) => {
	const { stack } = pr;
	if (!stack) {
		return null;
	}
	const { unstacking, updating, error, unstack, update } = actions;
	const openBelow = stack.pullRequests.filter(entry => entry.position < stack.position && entry.state === GithubItemStateEnum.Open).length;
	const canUnstack = pr.hasWritePermission && stack.pullRequests.some(entry => entry.state !== GithubItemStateEnum.Merged);
	const canUpdate = canUpdatePullRequestStack(pr);
	// Updating the stack is also how its conflicts are resolved, so the same action is named for the user's goal.
	const resolvesConflicts = stackHasConflicts(pr);

	return (
		<details className={`stack-section${canUnstack || canUpdate ? ' has-actions' : ''}`} id="pull-request-stack" open>
			<summary className="status-item">
				{layersIcon}
				<span className="stack-heading-text">
					<strong>Pull request stack</strong>
					<span className="stack-description">
						{pr.state === GithubItemStateEnum.Open && openBelow > 0
							? `Merging this pull request will also merge ${openBelow} pull request${openBelow === 1 ? '' : 's'} below it.`
							: `${stack.size} pull request${stack.size === 1 ? '' : 's'} in this stack.`}
					</span>
				</span>
				<span className="stack-chevron">{chevronDownIcon}</span>
			</summary>
			{canUnstack || canUpdate ? <div className="stack-actions">
				{canUpdate ? <button className="secondary" type="button" title={resolvesConflicts
					? 'Rebase all pull requests in this stack, resolve their conflicts, and push them'
					: 'Rebase and push all pull requests in this stack'}
					disabled={unstacking || updating || !!pr.stackMergeStatus} onClick={update}>
					{updating ? 'Updating...' : resolvesConflicts ? 'Resolve conflicts' : 'Update stack'}
				</button> : null}
				{canUnstack ? <button className="secondary" type="button" title="Unstack all eligible pull requests"
					disabled={unstacking || updating || !!pr.stackMergeStatus} onClick={unstack}>
					{unstacking ? 'Unstacking...' : 'Unstack all'}
				</button> : null}
			</div> : null}
			{error ? <div className="stack-action-error" role="alert">{error}</div> : null}
			<StackEntryList stack={stack} currentNumber={pr.number} />
		</details>
	);
};

/** The pull requests in a stack from top to bottom, followed by the branch that they merge down into. */
export const StackEntryList = ({ stack, currentNumber }: { stack: Stack; currentNumber: number }) => (
	<ol className="stack-entries" aria-label={`Pull requests merging down into ${stack.base}`}>
		{[...stack.pullRequests].reverse().map(entry => {
			const current = entry.number === currentNumber;
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
);
