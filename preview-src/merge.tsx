import * as React from 'react';
import { PullRequest } from './cache';
import PullRequestContext from './context';
import { groupBy } from 'lodash';
import { useContext, useReducer, useRef, useState } from 'react';
import { PullRequestStateEnum, MergeMethod } from '../src/github/interface';
import { checkIcon, deleteIcon, pendingIcon } from './icon';
import { Avatar, } from './user';
import { nbsp } from './space';

export const StatusChecks = (pr: PullRequest) => {
	const { state, status, mergeable } = pr;
	const [showDetails, toggleDetails] = useReducer(show => !show, false);

	return <div id='status-checks'>{
		state === PullRequestStateEnum.Merged
			? 'Pull request successfully merged'
			:
		state === PullRequestStateEnum.Closed
			? 'This pull request is closed'
			:
			<>
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
				<MergeStatus mergeable={mergeable} />
				{ mergeable ? <Merge {...pr} /> : null}
			</>
	}</div>;
};

export default StatusChecks;

export const MergeStatus = ({ mergeable }: Pick<PullRequest, 'mergeable'>) =>
	<div className='status-item status-section'>
		{mergeable ? checkIcon : deleteIcon}
		<div>{
			mergeable
				? 'This branch has no conflicts with the base branch'
				: 'This branch has conflicts that must be resolved'
		}</div>
	</div>;

export const Merge = (pr: PullRequest) => {
	const select = useRef<HTMLSelectElement>();
	const [ selectedMethod, selectMethod ] = useState<MergeMethod | null>(null);

	if (selectedMethod) {
		return <ConfirmMerge pr={pr} method={selectedMethod} cancel={() => selectMethod(null)} />;
	}

	return <div className='merge-select-container'>
		<button onClick={() => selectMethod(select.current.value as MergeMethod)}>Merge Pull Request</button>
		{nbsp}using method{nbsp}
		<MergeSelect ref={select} {...pr} />
	</div>;
};

function ConfirmMerge({pr, method, cancel}: {pr: PullRequest, method: MergeMethod, cancel: () => void}) {
	const { merge } = useContext(PullRequestContext);

	return <form onSubmit={
		event => {
			event.preventDefault();
			const {title, description}: any = event.target;
			merge({
				title: title.value,
				description: description.value,
				method,
			});
		}
	}>
		<input type='text' name='title' defaultValue={getDefaultTitleText(method, pr)} />
		<textarea name='description' defaultValue={getDefaultDescriptionText(method, pr)} />
		<div className='form-actions'>
			<button className='secondary' onClick={cancel}>Cancel</button>
			<input type='submit' id='confirm-merge' value={MERGE_METHODS[method]} />
		</div>
	</form>;
}

function getDefaultTitleText(mergeMethod: string, pr: PullRequest) {
	switch (mergeMethod) {
		case 'merge':
			return `Merge pull request #${pr.number} from ${pr.head}`;
		case 'squash':
			return pr.title;
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
					{text}{!avail[method] ? '(not enabled)' : null}
				</option>
			)
}</select>);

const StatusCheckDetails = ({ statuses }: Partial<PullRequest['status']>) =>
	<div>{
		statuses.map(s =>
			<div key={s.id} className='status-check'>
				<StateIcon state={s.state} />
				<Avatar for={{ avatarUrl: s.avatar_url, url: s.url }} />
				<span className='status-check-detail-text'>{s.context} — {s.description}</span>
				<a href={s.target_url}>Details</a>
			</div>
		)
	}</div>;

function getSummaryLabel(statuses: any[]) {
	const statusTypes = groupBy(statuses, (status: any) => status.state);
	let statusPhrases = [];
	for (let statusType of Object.keys(statusTypes)) {
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

const StateIcon = ({ state }: { state: string }) =>
	state === 'success'
		? checkIcon
		:
	state === 'failure'
		? deleteIcon
		:
		pendingIcon
		;
