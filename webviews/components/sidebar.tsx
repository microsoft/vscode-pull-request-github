/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { WorkItem } from 'azure-devops-node-api/interfaces/WorkItemTrackingInterfaces';
import * as React from 'react';
// eslint-disable-next-line no-duplicate-imports
import { useContext, useRef, useState } from 'react';
import { PullRequest } from '../common/cache';
import PullRequestContext from '../common/context';
import { deleteIcon, plusIcon } from './icon';
import { Reviewer } from './reviewer';
import { nbsp } from './space';

export default function Sidebar({ reviewers, workItems, hasWritePermission }: PullRequest) {
	const { addRequiredReviewers, addOptionalReviewers, associateWorkItem, updatePR, pr } = useContext(PullRequestContext);

	return (
		<div id="sidebar">
			<VotePanel vote={pr.reviewers.find(r => r.reviewer.id === pr.currentUser.id)?.state ?? 0} />
			<ReviewerPanel
				labelText="Required Reviewers"
				reviewers={reviewers.filter(r => r.isRequired)}
				addReviewers={addRequiredReviewers}
				hasWritePermission={hasWritePermission}
				updatePR={newReviewers => updatePR({ reviewers: pr.reviewers.concat(newReviewers.added) })}
			/>
			<ReviewerPanel
				labelText="Optional Reviewers"
				reviewers={reviewers.filter(r => !r.isRequired)}
				addReviewers={addOptionalReviewers}
				hasWritePermission={hasWritePermission}
				updatePR={newReviewers => updatePR({ reviewers: pr.reviewers.concat(newReviewers.added) })}
			/>
			<div id="work-item" className="section">
				<div className="section-header">
					<div>Work Items</div>
					{hasWritePermission ? (
						<button
							title="Add Work Items"
							onClick={async () => {
								await associateWorkItem();
							}}
						>
							{plusIcon}
						</button>
					) : null}
				</div>
				<div className="work-item-body-container">
					{workItems &&
						workItems.map(workItem => <WorkItem key={workItem.id} {...workItem} canDelete={hasWritePermission} />)}
				</div>
			</div>
		</div>
	);
}

function WorkItem(workItem: WorkItem & { canDelete: boolean }) {
	const canDelete = workItem.canDelete;
	const [showDelete, setShowDelete] = useState(false);
	const { removeWorkItemFromPR } = useContext(PullRequestContext);
	return (
		<div
			className="section-item work-item"
			onMouseEnter={() => setShowDelete(true)}
			onMouseLeave={() => setShowDelete(false)}
		>
			<WorkItemDetails {...workItem} />
			{canDelete && showDelete ? (
				<>
					{nbsp}
					<a className="push-right remove-item" onClick={() => removeWorkItemFromPR(workItem.id!)}>
						{deleteIcon}️
					</a>
					{nbsp}
				</>
			) : null}
		</div>
	);
}

const WorkItemDetails = (workItem: WorkItem) => (
	<div className="work-item-container">
		<a href={workItem._links['html']['href']}>
			<div className="work-item-type">{workItem.fields['System.WorkItemType']}</div>
			<div className="work-item-title">
				{workItem.id}: {workItem.fields['System.Title']}
				{}
			</div>
		</a>
	</div>
);

const ReviewerPanel = ({ reviewers, labelText, hasWritePermission, addReviewers, updatePR }) => (
	<div id="reviewers" className="section">
		<div className="section-header">
			<div>{labelText}</div>
			{hasWritePermission ? (
				<button
					title={`Add ${labelText}`}
					onClick={async () => {
						const newReviewers = await addReviewers();
						updatePR(newReviewers.added);
					}}
				>
					{plusIcon}
				</button>
			) : null}
		</div>
		{reviewers
			? reviewers.map(state => <Reviewer key={state.reviewer.id} {...state} canDelete={hasWritePermission} />)
			: []}
	</div>
);

export const VoteText = {
	'10': 'Approve',
	'5': 'Approve with Suggestion',
	'-5': 'Wait for author',
	'-10': 'Rejected',
	'0': 'Reset Vote',
};

const VoteOrder = ['10', '5', '-5', '-10', '0'];

const VotePanel = ({ vote }: { vote: number }) => {
	const select = useRef<HTMLSelectElement>();
	// eslint-disable-next-line @typescript-eslint/no-unused-expressions
	select;
	const { votePullRequest } = useContext(PullRequestContext);
	const [selectedVote, changeVote] = useState(vote.toString());

	const castVote = async (vote: string) => {
		await votePullRequest(parseInt(vote));
	};

	return (
		<>
			<div className="vote">
				<div className="vote-select">
					<VoteSelect currentVote={vote} changeVote={newVote => changeVote(newVote)} />
				</div>
				<button
					className="vote-button"
					onClick={async () => await castVote(selectedVote)}
					disabled={vote.toString() === selectedVote}
				>
					Cast Vote
				</button>
			</div>
		</>
	);
};

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

const VoteSelect = ({ currentVote, changeVote }) => (
	<select onChange={e => changeVote(e.target.value)} defaultValue={currentVote === 0 ? '10' : currentVote?.toString()}>
		{VoteOrder.map(vote => (
			<option key={vote} value={vote}>
				{VoteText[vote]}
				{currentVote?.toString() === vote ? ' (current vote)' : null}
			</option>
		))}
	</select>
);
