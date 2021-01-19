/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import { useContext, useRef, useState } from 'react';
import { PullRequest } from '../common/cache';
import { plusIcon, deleteIcon } from './icon';
import PullRequestContext from '../common/context';
import { ILabel } from '../../src/azdo/interface';
import { nbsp } from './space';
import { Reviewer } from './reviewer';

export default function Sidebar({ reviewers, labels, hasWritePermission }: PullRequest) {
	const { addReviewers, addLabels, updatePR, pr } = useContext(PullRequestContext);

	return <div id='sidebar'>
		<VotePanel vote={pr.reviewers.find(r => r.reviewer.id === pr.currentUser.id)?.state ?? 0} />
		<ReviewerPanel labelText='Required Reviewers' reviewers={reviewers.filter(r => r.isRequired)}
			addReviewers={addReviewers} hasWritePermission={hasWritePermission}
			updatePR={(newReviewers) => updatePR({ reviewers: pr.reviewers.concat(newReviewers.added) })}
		/>
		<ReviewerPanel labelText='Optional Reviewers' reviewers={reviewers.filter(r => !r.isRequired)}
			addReviewers={addReviewers} hasWritePermission={hasWritePermission}
			updatePR={(newReviewers) => updatePR({ reviewers: pr.reviewers.concat(newReviewers.added) })}
		/>
		<div id='labels' className='section'>
			<div className='section-header'>
				<div>Labels</div>
				{hasWritePermission ? (
					<button title='Add Labels' onClick={async () => {
						const newLabels = await addLabels();
						updatePR({ labels: pr.labels.concat(newLabels.added) });
					}}>{plusIcon}</button>
				) : null}
			</div>
			{
				labels && labels.map(label => <Label key={label.name} {...label} canDelete={hasWritePermission} />)
			}
		</div>
	</div>;
}

function Label(label: ILabel & { canDelete: boolean }) {
	const { name, canDelete } = label;
	const [showDelete, setShowDelete] = useState(false);
	const { removeLabel } = useContext(PullRequestContext);
	return <div className='section-item label'
		onMouseEnter={() => setShowDelete(true)}
		onMouseLeave={() => setShowDelete(false)}>
		{name}
		{canDelete && showDelete ? <>{nbsp}<a className='push-right remove-item' onClick={() => removeLabel(name)}>{deleteIcon}️</a>{nbsp}</> : null}
	</div>;
}

const ReviewerPanel = ({reviewers, labelText, hasWritePermission, addReviewers, updatePR}) => (
	<div id='reviewers' className='section'>
		<div className='section-header'>
			<div>{labelText}</div>
			{hasWritePermission ? (
				<button title={`Add ${labelText}`} onClick={async () => {
					const newReviewers = await addReviewers();
					updatePR(newReviewers.added);
				}}>{plusIcon}</button>
			) : null}
		</div>
		{
			reviewers ? reviewers.map(state =>
				<Reviewer key={state.reviewer.id} {...state} canDelete={hasWritePermission} />
			) : []
		}
	</div>
);

export const VoteText = {
	'10': 'Approve',
	'5': 'Approve with Suggestion',
	'-5': 'Wait for author',
	'-10': 'Rejected',
	'0': 'Reset Vote',
}

const VoteOrder = ['10', '5', '-5', '-10', '0']

const VotePanel = ({vote}: {vote: number}) => {
	const select = useRef<HTMLSelectElement>(); select;
	const { votePullRequest } = useContext(PullRequestContext);
	const [selectedVote, changeVote] = useState(vote.toString());

	const castVote = async (vote: string) => {
		await votePullRequest(parseInt(vote))
	}

	return <>
		<div className='vote'>
			<div className='vote-select'>
				<VoteSelect currentVote={vote} changeVote={(newVote) => changeVote(newVote)} />
			</div>
			<button className='vote-button' onClick={async () => await castVote(selectedVote)} disabled={vote.toString() === selectedVote}>Cast Vote</button>
		</div>
	</>
}

// const VoteSelect = React.forwardRef<HTMLSelectElement, {currentVote: number}>((
// 	{currentVote},
// 	ref) =>
// 	<select ref={ref} defaultValue={VoteText[currentVote === 0 ? '10' : currentVote.toString()]}>{
// 		VoteOrder
// 			.map((vote) =>
// 				<option key={vote} value={vote}>
// 					{VoteText[vote]}{currentVote.toString() === vote ? ' (current vote)' : null}
// 				</option>
// 			)
// 	}</select>);

const VoteSelect = (
	{currentVote, changeVote}) =>
	<select onChange={(e) => changeVote(e.target.value)} defaultValue={currentVote === 0 ? '10' : currentVote.toString()}>{
		VoteOrder
			.map((vote) =>
				<option key={vote} value={vote}>
					{VoteText[vote]}{currentVote.toString() === vote ? ' (current vote)' : null}
				</option>
			)
	}</select>;