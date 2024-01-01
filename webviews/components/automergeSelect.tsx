/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import { MergeMethod, MergeMethodsAvailability, MergeQueueEntry, MergeQueueState } from '../../src/github/interface';
import PullRequestContext from '../common/context';
import { MergeSelect } from './merge';

const AutoMergeLabel = ({ busy, baseHasMergeQueue }: { busy: boolean, baseHasMergeQueue: boolean }) => {
	if (busy) {
		return <label htmlFor="automerge-checkbox" className="automerge-checkbox-label">Setting...</label>;
	} else {
		return <label htmlFor="automerge-checkbox" className="automerge-checkbox-label">
			{baseHasMergeQueue ? 'Merge when ready' : 'Auto-merge'}
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
}: {
	updateState: (params: Partial<{ autoMerge: boolean; autoMergeMethod: MergeMethod }>) => Promise<void>;
	baseHasMergeQueue: boolean;
	allowAutoMerge?: boolean;
	defaultMergeMethod?: MergeMethod;
	mergeMethodsAvailability?: MergeMethodsAvailability;
	autoMerge?: boolean;
	isDraft?: boolean;
}) => {
	if ((!allowAutoMerge && !autoMerge) || !mergeMethodsAvailability || !defaultMergeMethod) {
		return null;
	}
	const select: React.MutableRefObject<HTMLSelectElement> = React.useRef<HTMLSelectElement>() as React.MutableRefObject<HTMLSelectElement>;

	const [isBusy, setBusy] = React.useState(false);
	const selectedMethod = (): MergeMethod => {
		const value: string = select.current?.value ?? 'merge';
		return value as MergeMethod;
	};

	return (
		<div className="automerge-section">
			<div className="automerge-checkbox-wrapper">
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
			<AutoMergeLabel busy={isBusy} baseHasMergeQueue={baseHasMergeQueue} />
			{baseHasMergeQueue ? null :
				<div className="merge-select-container">
					<MergeSelect
						ref={select}
						defaultMergeMethod={defaultMergeMethod}
						mergeMethodsAvailability={mergeMethodsAvailability}
						onChange={async () => {
							setBusy(true);
							await updateState({ autoMergeMethod: selectedMethod() });
							setBusy(false);
						}}
						disabled={isBusy}
					/>
				</div>
			}
		</div>
	);
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
			<button onClick={ctx.dequeue}>Remove from queue</button>
		</div>
	</div>;
};
