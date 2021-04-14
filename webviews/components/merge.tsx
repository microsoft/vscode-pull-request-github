/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { GitStatusState, PullRequestStatus } from 'azure-devops-node-api/interfaces/GitInterfaces';
import * as React from 'react';
// eslint-disable-next-line no-duplicate-imports
import { useCallback, useContext, useEffect, useReducer, useRef, useState } from 'react';
import { MergeMethod, PullRequestChecks, PullRequestMergeability } from '../../src/azdo/interface';
import { groupBy } from '../../src/common/utils';
import { PullRequest } from '../common/cache';
import PullRequestContext from '../common/context';
import { Reviewer } from '../components/reviewer';
import { Dropdown } from './dropdown';
import { alertIcon, checkIcon, deleteIcon, pendingIcon } from './icon';
import { nbsp } from './space';
import { Avatar } from './user';

export const StatusChecks = ({ pr, isSimple }: { pr: PullRequest; isSimple: boolean }) => {
	if (pr.isIssue) {
		return null;
	}
	const { state, status } = pr;
	const [showDetails, toggleDetails] = useReducer(
		show => !show,
		status.statuses.some(s => s.state === GitStatusState.Failed),
	) as [boolean, () => void];

	useEffect(() => {
		if (status.statuses.some(s => s.state === GitStatusState.Failed || s.state === GitStatusState.Error)) {
			if (!showDetails) {
				toggleDetails();
			}
		} else {
			if (showDetails) {
				toggleDetails();
			}
		}
	}, status.statuses);

	return (
		<div id="status-checks">
			{state === PullRequestStatus.Completed ? (
				<>
					<div className="branch-status-message">{'Pull request successfully merged.'}</div>
					{/* <DeleteBranch {...pr} /> */}
				</>
			) : state === PullRequestStatus.Abandoned ? (
				<>
					<div className="branch-status-message">{'This pull request is abondoned.'}</div>
					{/* <DeleteBranch {...pr} /> */}
				</>
			) : (
				<>
					{status.statuses.length ? (
						<>
							<div className="status-section">
								<div className="status-item">
									<StateIcon state={status.state} />
									<div>{getSummaryLabel(status.statuses)}</div>
									<a aria-role="button" onClick={toggleDetails}>
										{showDetails ? 'Hide' : 'Show'}
									</a>
								</div>
								{showDetails ? <StatusCheckDetails statuses={status.statuses} /> : null}
							</div>
						</>
					) : null}
					{isSimple
						? pr.reviewers
							? pr.reviewers.map(state => <Reviewer key={state.reviewer.id} {...state} canDelete={false} />)
							: []
						: null}
					<MergeStatusAndActions pr={pr} isSimple={isSimple} />
				</>
			)}
		</div>
	);
};

export const MergeStatusAndActions = ({ pr, isSimple }: { pr: PullRequest; isSimple: boolean }) => {
	const { mergeable: _mergeable } = pr;

	const [mergeable, setMergeability] = useState(_mergeable);
	const { checkMergeability } = useContext(PullRequestContext);

	useEffect(() => {
		const handle = setInterval(async () => {
			if (mergeable === PullRequestMergeability.NotSet || mergeable === PullRequestMergeability.Queued) {
				setMergeability(await checkMergeability());
			}
		}, 3000);
		return () => clearInterval(handle);
	});

	return (
		<span>
			<MergeStatus mergeable={mergeable} isSimple={isSimple} />
			<PrActions pr={{ ...pr, mergeable }} isSimple={isSimple} />
		</span>
	);
};

export default StatusChecks;

export const MergeStatus = ({ mergeable, isSimple }: { mergeable: PullRequestMergeability; isSimple: boolean }) => {
	return (
		<div className="status-item status-section">
			{isSimple
				? null
				: mergeable === PullRequestMergeability.Succeeded
				? checkIcon
				: mergeable === PullRequestMergeability.RejectedByPolicy || mergeable === PullRequestMergeability.Failure
				? deleteIcon
				: pendingIcon}
			<div>
				{mergeable === PullRequestMergeability.Succeeded
					? 'This branch has no conflicts with the base branch.'
					: mergeable === PullRequestMergeability.Queued
					? 'Checking if this branch can be merged...'
					: 'This branch has conflicts that must be resolved.'}
			</div>
		</div>
	);
};

export const ReadyForReview = () => {
	const [isBusy, setBusy] = useState(false);
	const { readyForReview, updatePR } = useContext(PullRequestContext);

	const markReadyForReview = useCallback(async () => {
		try {
			setBusy(true);
			await readyForReview();
			updatePR({ isDraft: false });
		} finally {
			setBusy(false);
		}
	}, [setBusy, readyForReview, updatePR]);

	return (
		<div className="ready-for-review-container">
			<button className="ready-for-review-button" disabled={isBusy} onClick={markReadyForReview}>
				Ready for review
			</button>
			<div className="ready-for-review-icon">{alertIcon}</div>
			<div className="ready-for-review-heading">This pull request is still a work in progress.</div>
			<span className="ready-for-review-meta">Draft pull requests cannot be merged.</span>
		</div>
	);
};

export const Merge = (pr: PullRequest) => {
	const select = useRef<HTMLSelectElement>();
	const [selectedMethod, selectMethod] = useState<MergeMethod | null>(null);

	if (selectedMethod) {
		return <ConfirmMerge pr={pr} method={selectedMethod} cancel={() => selectMethod(null)} />;
	}

	return (
		<>
			<div className="merge-select-container">
				<button onClick={() => selectMethod(select.current.value as MergeMethod)}>Merge Pull Request</button>
				{nbsp}using method{nbsp}
				<MergeSelect ref={select} {...pr} />
			</div>
		</>
	);
};

export const PrActions = ({ pr, isSimple }: { pr: PullRequest; isSimple: boolean }) => {
	const { hasWritePermission, canEdit, isDraft, mergeable } = pr;

	return isDraft ? (
		// Only PR author and users with push rights can mark draft as ready for review
		canEdit ? (
			<ReadyForReview />
		) : null
	) : mergeable === PullRequestMergeability.Succeeded && hasWritePermission ? (
		isSimple ? (
			<MergeSimple {...pr} />
		) : (
			<Merge {...pr} />
		)
	) : null;
};

export const MergeSimple = (pr: PullRequest) => {
	const { merge, updatePR } = useContext(PullRequestContext);
	async function submitAction(selected: MergeMethod): Promise<void> {
		const { state } = await merge({
			title: '',
			description: '',
			method: selected,
		});
		updatePR({ state });
	}

	const availableOptions = Object.keys(MERGE_METHODS)
		.filter(method => pr.mergeMethodsAvailability[method])
		.reduce((methods, key) => {
			methods[key] = MERGE_METHODS[key];
			return methods;
		}, {});

	return <Dropdown options={availableOptions} defaultOption={pr.defaultMergeMethod} submitAction={submitAction} />;
};

export const DeleteBranch = (pr: PullRequest) => {
	const { deleteBranch } = useContext(PullRequestContext);
	const [isBusy, setBusy] = useState(false);

	if (pr.head === 'UNKNOWN') {
		return <div />;
	} else {
		return (
			<div className="branch-status-container">
				<form
					onSubmit={async event => {
						event.preventDefault();

						try {
							setBusy(true);
							const result = await deleteBranch();
							if (result && result.cancelled) {
								setBusy(false);
							}
						} finally {
							setBusy(false);
						}
					}}
				>
					<button disabled={isBusy} type="submit">
						Delete branch
					</button>
				</form>
			</div>
		);
	}
};

function ConfirmMerge({ pr, method, cancel }: { pr: PullRequest; method: MergeMethod; cancel: () => void }) {
	const { complete } = useContext(PullRequestContext);
	const [isBusy, setBusy] = useState(false);

	return (
		<form
			onSubmit={async event => {
				event.preventDefault();

				try {
					setBusy(true);
					const { completeWorkitem, deleteBranch }: any = event.target;
					await complete({
						deleteSourceBranch: deleteBranch.checked,
						completeWorkitem: completeWorkitem.checked,
						mergeStrategy: method.toString(),
					});
				} finally {
					setBusy(false);
				}
			}}
		>
			<div className="merge-option-container">
				<div>
					<label>
						<input name="completeWorkitem" type="checkbox" defaultChecked={true} />
						Complete associated work items after merging
					</label>
				</div>
				<div>
					<label>
						<input name="deleteBranch" type="checkbox" defaultChecked={true} />
						Delete branch after merging
					</label>
				</div>
			</div>
			<div className="form-actions">
				<button className="secondary" onClick={cancel}>
					Cancel
				</button>
				<input disabled={isBusy} type="submit" id="confirm-merge" value={MERGE_METHODS[method]} />
			</div>
		</form>
	);
}

// function getDefaultTitleText(mergeMethod: string, pr: PullRequest) {
// 	switch (mergeMethod) {
// 		case 'merge':
// 			return `Merge pull request #${pr.number} from ${pr.head}`;
// 		case 'squash':
// 			return `${pr.title} (#${pr.number})`;
// 		default:
// 			return '';
// 	}
// }

// function getDefaultDescriptionText(mergeMethod: string, pr: PullRequest) {
// 	return mergeMethod === 'merge' ? pr.title : '';
// }

const MERGE_METHODS = {
	NoFastForward: 'Create Merge Commit',
	Squash: 'Squash Commit',
	Rebase: 'Rebase and Fast Forward',
	RebaseMerge: 'Semi-Linear Merge',
};

export type MergeSelectProps = Pick<PullRequest, 'mergeMethodsAvailability'> & Pick<PullRequest, 'defaultMergeMethod'>;

export const MergeSelect = React.forwardRef<HTMLSelectElement, MergeSelectProps>(
	({ defaultMergeMethod, mergeMethodsAvailability: avail }: MergeSelectProps, ref) => (
		<select ref={ref} defaultValue={defaultMergeMethod}>
			{Object.entries(MERGE_METHODS).map(([method, text]) => (
				<option key={method} value={method} disabled={!avail[method]}>
					{text}
					{!avail[method] ? ' (not enabled)' : null}
				</option>
			))}
		</select>
	),
);

const StatusCheckDetails = ({ statuses }: Partial<PullRequest['status']>) => (
	<div>
		{statuses.map(s => (
			<div key={s.id} className="status-check">
				<div>
					<StateIcon state={s.state} />
					<Avatar url={s.url} avatarUrl={s.avatar_url} />
					<span className="status-check-detail-text">
						{s.context} {s.description ? `— ${s.description}` : ''}
					</span>
				</div>
				{!!s.target_url ? <a href={s.target_url}>Details</a> : null}
			</div>
		))}
	</div>
);

function getSummaryLabel(statuses: PullRequestChecks['statuses']) {
	const statusTypes = groupBy(statuses, status =>
		!!status.state ? status.state.toString() : GitStatusState.NotSet.toString(),
	);
	const statusPhrases = [];
	for (const statusType of Object.keys(statusTypes)) {
		const numOfType = statusTypes[statusType].length;
		const statusAdjective = GitStatusState[statusType].toString();

		const status = numOfType > 1 ? `${numOfType} ${statusAdjective} checks` : `${numOfType} ${statusAdjective} check`;

		statusPhrases.push(status);
	}

	return statusPhrases.join(' and ');
}

function StateIcon({ state }: { state: GitStatusState }) {
	switch (state) {
		case GitStatusState.Succeeded:
			return checkIcon;
		case GitStatusState.Error:
			return deleteIcon;
		case GitStatusState.Failed:
			return deleteIcon;
	}
	return pendingIcon;
}
