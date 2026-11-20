/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import { MergeSelect } from './merge';
import { GithubItemStateEnum, MergeMethod, MergeMethodsAvailability, MergeQueueEntry, MergeQueueState } from '../../src/github/interface';
import { PullRequest } from '../../src/github/views';
import PullRequestContext from '../common/context';

const AUTO_MERGE_LABEL = 'Merge automatically when requirements are met';
const MERGE_WHEN_READY_LABEL = 'Merge when ready';

const AutoMergeLabel = ({ busy, baseHasMergeQueue, label }: { busy: boolean, baseHasMergeQueue: boolean, label?: string }) => {
	if (busy) {
		return <label htmlFor="automerge-checkbox" className="automerge-checkbox-label">Setting...</label>;
	} else {
		return <label htmlFor="automerge-checkbox" className="automerge-checkbox-label">
			{label ?? (baseHasMergeQueue ? MERGE_WHEN_READY_LABEL : AUTO_MERGE_LABEL)}
		</label>;
	}
};

export const AutoMerge = ({
	updateState,
	baseHasMergeQueue,
	allowAutoMerge,
	defaultMergeMethod,
	mergeMethodsAvailability,
	autoMerge,
	isDraft,
	label,
	canChangeMethod = true,
}: {
	updateState: (params: Partial<{ autoMerge: boolean; autoMergeMethod: MergeMethod }>) => Promise<void>;
	baseHasMergeQueue: boolean;
	allowAutoMerge?: boolean;
	defaultMergeMethod?: MergeMethod;
	mergeMethodsAvailability?: MergeMethodsAvailability;
	autoMerge?: boolean;
	isDraft?: boolean;
	label?: string;
	canChangeMethod?: boolean;
}) => {
	// Hooks come before the early return, since whether auto-merge is allowed changes with the merge state.
	const select: React.MutableRefObject<HTMLSelectElement> = React.useRef<HTMLSelectElement>() as React.MutableRefObject<HTMLSelectElement>;
	const [isBusy, setBusy] = React.useState(false);
	if ((!allowAutoMerge && !autoMerge) || !mergeMethodsAvailability || !defaultMergeMethod) {
		return null;
	}

	const selectedMethod = (): MergeMethod => {
		const value: string = select.current?.value ?? 'merge';
		return value as MergeMethod;
	};

	return (
		<div className="automerge-section">
			<div className="automerge-checkbox-wrapper checkbox-wrapper">
				<input
					id="automerge-checkbox"
					type="checkbox"
					name="automerge"
					checked={autoMerge}
					disabled={!allowAutoMerge || isDraft || isBusy}
					onChange={async () => {
						setBusy(true);
						await updateState({ autoMerge: !autoMerge, autoMergeMethod: selectedMethod() });
						setBusy(false);
					}}
				></input>
			</div>
			<AutoMergeLabel busy={isBusy} baseHasMergeQueue={baseHasMergeQueue} label={label} />
			{baseHasMergeQueue ? null :
				<div className="merge-select-container">
					<MergeSelect
						// A method that can't be changed is that of the active request, so the select follows it, rather than
						// keeping the method that was chosen before the request was enabled.
						key={canChangeMethod ? undefined : defaultMergeMethod}
						ref={select}
						defaultMergeMethod={defaultMergeMethod}
						mergeMethodsAvailability={mergeMethodsAvailability}
						onChange={async () => {
							setBusy(true);
							await updateState({ autoMergeMethod: selectedMethod() });
							setBusy(false);
						}}
						disabled={isBusy || !canChangeMethod}
					/>
				</div>
			}
		</div>
	);
};

const MERGE_METHOD_ORDER: MergeMethod[] = ['merge', 'squash', 'rebase'];

/** Auto-merge for a stacked pull request together with the open pull requests below it, which GitHub merges with it. */
export const StackAutoMerge = ({ pr }: { pr: PullRequest }) => {
	const ctx = React.useContext(PullRequestContext);
	const { stack, stackAutoMerge } = pr;
	if (!stack || !stackAutoMerge) {
		return null;
	}
	const enabled = stackAutoMerge.enabledThrough !== undefined;
	// A request enabled on a pull request above this one covers it too.
	const enabledAbove = enabled && stackAutoMerge.enabledThrough !== pr.number ? stackAutoMerge.enabledThrough : undefined;
	const count = 1 + stack.pullRequests.filter(entry => entry.state === GithubItemStateEnum.Open && entry.position < stack.position).length;
	const availability = pr.mergeMethodsAvailability;
	const defaultMergeMethod = stackAutoMerge.mergeMethod
		?? (availability[pr.defaultMergeMethod] ? pr.defaultMergeMethod : MERGE_METHOD_ORDER.find(method => availability[method]));
	const queue = !!pr.mergeQueueMethod;
	const action = queue ? MERGE_WHEN_READY_LABEL : AUTO_MERGE_LABEL;
	// Shown even for one pull request, so that it is clear that the pull requests above are not merged with it.
	const label = enabledAbove !== undefined
		? `${action} (enabled through #${enabledAbove})`
		: `${action} (${count} pull request${count === 1 ? '' : 's'})`;
	return <AutoMerge
		// The merge method is only chosen before enabling: GitHub can't change it on a request, and replacing the request
		// would leave the stack without auto-merge if enabling it again failed.
		updateState={async ({ autoMerge, autoMergeMethod }) => {
			if (autoMerge !== undefined) {
				await ctx.updateStackAutoMerge({
					autoMerge,
					autoMergeMethod: autoMergeMethod ?? defaultMergeMethod ?? 'merge',
					expectedEnabledThrough: stackAutoMerge.enabledThrough,
				});
			}
		}}
		baseHasMergeQueue={queue}
		allowAutoMerge={enabled ? stackAutoMerge.viewerCanDisable : stackAutoMerge.viewerCanEnable}
		defaultMergeMethod={defaultMergeMethod}
		mergeMethodsAvailability={availability}
		autoMerge={enabled}
		isDraft={pr.isDraft}
		label={label}
		canChangeMethod={!enabled}
	/>;
};

export const QueuedToMerge = ({ mergeQueueEntry }: { mergeQueueEntry: MergeQueueEntry }) => {
	const ctx = React.useContext(PullRequestContext);
	let message;
	let title;
	switch (mergeQueueEntry.state) {
		case (MergeQueueState.Mergeable): // TODO @alexr00 What does "Mergeable" mean in the context of a merge queue?
		case (MergeQueueState.AwaitingChecks):
		case (MergeQueueState.Queued): {
			title = <span className="merge-queue-pending">Queued to merge...</span>;
			if (mergeQueueEntry.position === 1) {
				message = <span>This pull request is at the head of the <a href={mergeQueueEntry.url}>merge queue</a>.</span>;
			} else {
				message = <span>This pull request is in the <a href={mergeQueueEntry.url}>merge queue</a>.</span>;
			}
			break;
		}
		case (MergeQueueState.Locked): {
			title = <span className="merge-queue-blocked">Merging is blocked</span>;
			message = <span>The base branch does not allow updates</span>;
			break;
		}
		case (MergeQueueState.Unmergeable): {
			title = <span className="merge-queue-blocked">Merging is blocked</span>;
			message = <span>There are conflicts with the base branch.</span>;
			break;
		}
	}
	return <div className="merge-queue-container">
		<div className="merge-queue">
			<div className="merge-queue-icon"></div>
			<div className="merge-queue-title">{title}</div>
			{message}
		</div>
		<div className='button-container'>
			<button onClick={ctx.dequeue}>Remove from Queue</button>
		</div>
	</div>;
};
