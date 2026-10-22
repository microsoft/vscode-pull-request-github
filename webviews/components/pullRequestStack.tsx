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

/** Stack actions share their progress with every control that can trigger them, and starting one clears both errors. */
export interface StackActions {
	unstacking: boolean;
	updating: boolean;
	/** Shown with the stack, where it is unstacked. */
	unstackError?: string;
	/** Shown with the branch status, where the stack is updated. */
	updateError?: string;
	unstack(): Promise<void>;
	update(): Promise<void>;
}

export function useStackActions(): StackActions {
	const { unstackAll, updateStack } = React.useContext(PullRequestContext);
	const [unstacking, setUnstacking] = React.useState(false);
	const [updating, setUpdating] = React.useState(false);
	const [unstackError, setUnstackError] = React.useState<string | undefined>();
	const [updateError, setUpdateError] = React.useState<string | undefined>();
	const clearErrors = () => {
		setUnstackError(undefined);
		setUpdateError(undefined);
	};

	const unstack = async () => {
		try {
			setUnstacking(true);
			clearErrors();
			await unstackAll();
		} catch (unstackFailure) {
			setUnstackError(`Unable to unstack pull requests: ${unstackFailure instanceof Error ? unstackFailure.message || unstackFailure.name : String(unstackFailure)}`);
		} finally {
			setUnstacking(false);
		}
	};

	const update = async () => {
		try {
			setUpdating(true);
			clearErrors();
			await updateStack();
		} catch (updateFailure) {
			setUpdateError(`Unable to update the stack: ${updateFailure instanceof Error ? updateFailure.message || updateFailure.name : String(updateFailure)}`);
		} finally {
			setUpdating(false);
		}
	};

	return { unstacking, updating, unstackError, updateError, unstack, update };
}

/** Rebases the stack's pull requests onto their bases, which is how they are brought up to date and their conflicts resolved. */
export const StackUpdateButton = ({ pr, actions }: { pr: PullRequest; actions: StackActions }) => {
	// Updating the stack is also how its conflicts are resolved, so the same action is named for the user's goal.
	const resolvesConflicts = stackHasConflicts(pr);
	return (
		<button className="secondary" type="button" title={resolvesConflicts
			? 'Rebase all pull requests in this stack, resolve their conflicts, and push them'
			: 'Rebase and push all pull requests in this stack'}
			disabled={actions.unstacking || actions.updating || !!pr.stackMergeStatus} onClick={actions.update}>
			{actions.updating ? 'Updating...' : resolvesConflicts ? 'Resolve conflicts' : 'Update stack'}
		</button>
	);
};

export const StackSection = ({ pr, actions }: { pr: PullRequest; actions: StackActions }) => {
	const [expanded, setExpanded] = React.useState(true);
	const { stack } = pr;
	if (!stack) {
		return null;
	}
	const { unstacking, updating, unstackError, unstack } = actions;
	const openBelow = stack.pullRequests.filter(entry => entry.position < stack.position && entry.state === GithubItemStateEnum.Open).length;
	const canUnstack = pr.hasWritePermission && stack.pullRequests.some(entry => entry.state !== GithubItemStateEnum.Merged);
	const toggle = () => setExpanded(open => !open);

	// A summary cannot hold the Unstack all button, so the header is laid out as a grid with the button in it,
	// and the chevron is the disclosure control.
	return (
		<div className="stack-section" id="pull-request-stack">
			{/* Like a summary, clicking anywhere in the header that is not a button toggles the stack. */}
			<div className="stack-header status-item" onClick={event => {
				if (!(event.target instanceof Element && event.target.closest('button'))) {
					toggle();
				}
			}}>
				{layersIcon}
				<span className="stack-heading-text">
					<strong>Pull request stack</strong>
					<span className="stack-description">
						{pr.state === GithubItemStateEnum.Open && openBelow > 0
							? `Merging this pull request will also merge ${openBelow} pull request${openBelow === 1 ? '' : 's'} below it.`
							: `${stack.size} pull request${stack.size === 1 ? '' : 's'} in this stack.`}
					</span>
				</span>
				{canUnstack && expanded ? <div className="stack-actions">
					<button className="secondary" type="button" title="Unstack all eligible pull requests"
						disabled={unstacking || updating || !!pr.stackMergeStatus} onClick={unstack}>
						{unstacking ? 'Unstacking...' : 'Unstack all'}
					</button>
				</div> : null}
				<button className="icon-button stack-chevron" type="button" aria-expanded={expanded} aria-controls="pull-request-stack-content"
					aria-label={expanded ? 'Collapse pull request stack' : 'Expand pull request stack'}
					title={expanded ? 'Collapse pull request stack' : 'Expand pull request stack'} onClick={toggle}>
					{chevronDownIcon}
				</button>
			</div>
			<div id="pull-request-stack-content" hidden={!expanded}>
				{unstackError ? <div className="stack-action-error" role="alert">{unstackError}</div> : null}
				<StackEntryList stack={stack} currentNumber={pr.number} />
			</div>
		</div>
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
