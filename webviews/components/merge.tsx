/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import { PullRequest } from '../common/cache';
import PullRequestContext from '../common/context';
import { useContext, useReducer, useRef, useState, useEffect, useCallback } from 'react';
import { GithubItemStateEnum, MergeMethod, PullRequestMergeability } from '../../src/github/interface';
import { checkIcon, deleteIcon, pendingIcon, alertIcon } from './icon';
import { Avatar, } from './user';
import { nbsp } from './space';
import { groupBy } from '../../src/common/utils';
import { Reviewer } from '../components/reviewer';
import { Dropdown } from './dropdown';

export const StatusChecks = ({ pr, isSimple }: { pr: PullRequest, isSimple: boolean }) => {
	if (pr.isIssue) {
		return null;
	}
	const { state, status } = pr;
	const [showDetails, toggleDetails] = useReducer(
		show => !show,
		status.statuses.some(s => s.state === 'failure')) as [boolean, () => void];

	useEffect(() => {
		if (status.statuses.some(s => s.state === 'failure')) {
			if (!showDetails) { toggleDetails(); }
		} else {
			if (showDetails) { toggleDetails(); }
		}
	}, status.statuses);

	return <div id='status-checks'>{
		state === GithubItemStateEnum.Merged
			?
			<>
				<div className='branch-status-message'>{'Pull request successfully merged.'}</div>
				<DeleteBranch {...pr} />
			</>
			:
			state === GithubItemStateEnum.Closed
				?
				<>
					<div className='branch-status-message'>{'This pull request is closed.'}</div>
					<DeleteBranch {...pr} />
				</>
				:
				<>
					{status.statuses.length
						? <>
							<div className='status-section'>
								<div className='status-item'>
									<StateIcon state={status.state} />
									<div>{getSummaryLabel(status.statuses)}</div>
									<a aria-role='button' onClick={toggleDetails}>{
										showDetails ? 'Hide' : 'Show'
									}</a>
								</div>
								{showDetails ?
									<StatusCheckDetails statuses={status.statuses} />
									: null}
							</div>
						</>
						: null
					}
					{
						isSimple
							? pr.reviewers
								? pr.reviewers.map(state =>
									<Reviewer key={state.reviewer.login} {...state} canDelete={false} />
								)
								: []
							: null
					}
					<MergeStatusAndActions pr={pr} isSimple={isSimple} />
				</>
	}</div>;
};

export const MergeStatusAndActions = ({ pr, isSimple }: { pr: PullRequest, isSimple: boolean }) => {
	const { mergeable: _mergeable } = pr;

	const [mergeable, setMergeability] = useState(_mergeable);
	const { checkMergeability } = useContext(PullRequestContext);

	useEffect(() => {
		const handle = setInterval(async () => {
			if (mergeable === PullRequestMergeability.Unknown) {
				setMergeability(await checkMergeability());
			}
		}, 3000);
		return () => clearInterval(handle);
	});

	return <span>
		<MergeStatus mergeable={mergeable} isSimple={isSimple} />
		<PrActions pr={{ ...pr, mergeable }} isSimple={isSimple} />
	</span>
}

export default StatusChecks;

export const MergeStatus = ({ mergeable, isSimple }: { mergeable: PullRequestMergeability, isSimple: boolean }) => {
	return <div className='status-item status-section'>
		{isSimple
			? null
			: mergeable === PullRequestMergeability.Mergeable
				? checkIcon
				: mergeable === PullRequestMergeability.NotMergeable
					? deleteIcon
					: pendingIcon}
		<div>{
			mergeable === PullRequestMergeability.Mergeable
				? 'This branch has no conflicts with the base branch.'
				: mergeable === PullRequestMergeability.NotMergeable
					? 'This branch has conflicts that must be resolved.'
					: 'Checking if this branch can be merged...'
		}</div>
	</div>;
};

export const ReadyForReview = ({ isSimple }: { isSimple: boolean }) => {
	const [isBusy, setBusy] = useState(false);
	const { readyForReview, updatePR } = useContext(PullRequestContext);

	const markReadyForReview = useCallback(
		async () => {
			try {
				setBusy(true);
				await readyForReview();
				updatePR({ isDraft: false });
			} finally {
				setBusy(false);
			}
		},
		[setBusy, readyForReview, updatePR]);

	return <div className='ready-for-review-container'>
		<div className='select-control'>
			<button className='ready-for-review-button' disabled={isBusy} onClick={markReadyForReview}>Ready for review</button>
		</div>
		{ isSimple ? '' : <div className='ready-for-review-icon'>{alertIcon}</div>}
		<div className='ready-for-review-heading'>This pull request is still a work in progress.</div>
		<span className='ready-for-review-meta'>Draft pull requests cannot be merged.</span>
	</div>;
};

export const Merge = (pr: PullRequest) => {
	const select = useRef<HTMLSelectElement>();
	const [selectedMethod, selectMethod] = useState<MergeMethod | null>(null);

	if (selectedMethod) {
		return <ConfirmMerge pr={pr} method={selectedMethod} cancel={() => selectMethod(null)} />;
	}

	return <div className='merge-select-container'>
		<button onClick={() => selectMethod(select.current.value as MergeMethod)}>Merge Pull Request</button>
		{nbsp}using method{nbsp}
		<MergeSelect ref={select} {...pr} />
	</div>;
};



export const PrActions = ({ pr, isSimple }: { pr: PullRequest, isSimple: boolean }) => {
	const { hasWritePermission, canEdit, isDraft, mergeable } = pr;

	return isDraft
		// Only PR author and users with push rights can mark draft as ready for review
		? canEdit
			? <ReadyForReview isSimple={isSimple}/>
			: null
		: mergeable === PullRequestMergeability.Mergeable && hasWritePermission
			? isSimple
				? <MergeSimple {...pr} />
				: <Merge {...pr} />
			: null;
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
			methods[key] = MERGE_METHODS[key]
			return methods;
		}, {})

	return <Dropdown options={availableOptions} defaultOption={pr.defaultMergeMethod} submitAction={submitAction} />
};

export const DeleteBranch = (pr: PullRequest) => {
	const { deleteBranch } = useContext(PullRequestContext);
	const [isBusy, setBusy] = useState(false);

	if (pr.head === 'UNKNOWN') {
		return <div />;
	} else {
		return <div className='branch-status-container'>
			<form onSubmit={
				async event => {
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
				}
			}>
				<button disabled={isBusy} type='submit'>Delete branch</button>
			</form>
		</div>;
	}
};

function ConfirmMerge({ pr, method, cancel }: { pr: PullRequest, method: MergeMethod, cancel: () => void }) {
	const { merge, updatePR } = useContext(PullRequestContext);
	const [isBusy, setBusy] = useState(false);

	return <form onSubmit={
		async event => {
			event.preventDefault();

			try {
				setBusy(true);
				const { title, description }: any = event.target;
				const { state } = await merge({
					title: title.value,
					description: description.value,
					method,
				});
				updatePR({ state });
			} finally {
				setBusy(false);
			}
		}
	}>
		<input type='text' name='title' defaultValue={getDefaultTitleText(method, pr)} />
		<textarea name='description' defaultValue={getDefaultDescriptionText(method, pr)} />
		<div className='form-actions'>
			<button className='secondary' onClick={cancel}>Cancel</button>
			<input disabled={isBusy} type='submit' id='confirm-merge' value={MERGE_METHODS[method]} />
		</div>
	</form>;
}

function getDefaultTitleText(mergeMethod: string, pr: PullRequest) {
	switch (mergeMethod) {
		case 'merge':
			return `Merge pull request #${pr.number} from ${pr.head}`;
		case 'squash':
			return `${pr.title} (#${pr.number})`;
		default:
			return '';
	}
}

function getDefaultDescriptionText(mergeMethod: string, pr: PullRequest) {
	return mergeMethod === 'merge' ? pr.title : '';
}

const MERGE_METHODS = {
	merge: 'Create Merge Commit',
	squash: 'Squash and Merge',
	rebase: 'Rebase and Merge',
};

type MergeSelectProps =
	Pick<PullRequest, 'mergeMethodsAvailability'> &
	Pick<PullRequest, 'defaultMergeMethod'>;

const MergeSelect = React.forwardRef<HTMLSelectElement, MergeSelectProps>((
	{ defaultMergeMethod, mergeMethodsAvailability: avail }: MergeSelectProps,
	ref) =>
	<select ref={ref} defaultValue={defaultMergeMethod}>{
		Object.entries(MERGE_METHODS)
			.map(([method, text]) =>
				<option key={method} value={method} disabled={!avail[method]}>
					{text}{!avail[method] ? ' (not enabled)' : null}
				</option>
			)
	}</select>);

const StatusCheckDetails = ({ statuses }: Partial<PullRequest['status']>) =>
	<div>{
		statuses.map(s =>
			<div key={s.id} className='status-check'>
				<div>
					<StateIcon state={s.state} />
					<Avatar for={{ avatarUrl: s.avatar_url, url: s.url }} />
					<span className='status-check-detail-text'>{s.context} {s.description ? `— ${s.description}` : ''}</span>
				</div>
				{!!s.target_url ? <a href={s.target_url}>Details</a> : null}
			</div>
		)
	}</div>;

function getSummaryLabel(statuses: any[]) {
	const statusTypes = groupBy(statuses, (status: any) => status.state);
	const statusPhrases = [];
	for (const statusType of Object.keys(statusTypes)) {
		const numOfType = statusTypes[statusType].length;
		let statusAdjective = '';

		switch (statusType) {
			case 'success':
				statusAdjective = 'successful';
				break;
			case 'failure':
				statusAdjective = 'failed';
				break;
			default:
				statusAdjective = 'pending';
		}

		const status = numOfType > 1
			? `${numOfType} ${statusAdjective} checks`
			: `${numOfType} ${statusAdjective} check`;

		statusPhrases.push(status);
	}

	return statusPhrases.join(' and ');
}

function StateIcon({ state }: { state: string }) {
	switch (state) {
		case 'success': return checkIcon;
		case 'failure': return deleteIcon;
	}
	return pendingIcon;
}
