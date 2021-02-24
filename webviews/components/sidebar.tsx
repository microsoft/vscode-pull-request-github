/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import { useContext, useState } from 'react';
import { PullRequest } from '../common/cache';
import { plusIcon, deleteIcon } from './icon';
import PullRequestContext from '../common/context';
import { ILabel } from '../../src/github/interface';
import { nbsp } from './space';
import { Reviewer } from './reviewer';
import { Avatar, AuthorLink } from '../components/user';

export default function Sidebar({ reviewers, labels, hasWritePermission, isIssue, milestone,assignees}: PullRequest) {
	const { addReviewers,addAssignees, addMilestones, addLabels, updatePR, pr } = useContext(PullRequestContext);
	return <div id='sidebar'>
		{!isIssue
			? <div id='reviewers' className='section'>
				<div className='section-header'>
					<div>Reviewers</div>
					{hasWritePermission ? (
						<button title='Add Reviewers' onClick={async () => {
							const newReviewers = await addReviewers();
							updatePR({ reviewers: pr.reviewers.concat(newReviewers.added) });
						}}>{plusIcon}</button>
					) : null}
				</div>
				{
					reviewers ? reviewers.map(state =>
						<Reviewer key={state.reviewer.login} {...state} canDelete={hasWritePermission} />
					) : []
				}
			</div>
			: ''}
		<div id='assignes' className="section">
			<div className='section-header'>
				<div>Assignees</div>
				{hasWritePermission ? (
						<button title='Add Assignees' onClick={async () => {
							const newAssignees = await addAssignees();
							updatePR({ assignees: pr.assignees.concat(newAssignees.added) });
						}}>{plusIcon}</button>
					) : null}
			</div>
			{assignees ? (assignees.map((x,i) => {
				return <div key={i} className='section-item reviewer'>
					<Avatar for={x} />
					<AuthorLink for={x} />
				</div>;
			})): (null)}
		</div>
		<div id='labels' className='section'>
			<div className='section-header'>
				<div>Labels</div>
				{hasWritePermission ? (
					<button title='Add Labels' onClick={async () => {
						const newLabels = await addLabels();
						console.log(newLabels);
						updatePR({ labels: pr.labels.concat(newLabels.added) });
					}}>{plusIcon}</button>
				) : null}
			</div>
			{
				labels.map(label => <Label key={label.name} {...label} canDelete={hasWritePermission} />)
			}
		</div>
		<div id='milestone' className="section">
			<div className='section-header'>
				<div>Milestone</div>
				{hasWritePermission ? (
					<button title='Add Milestone' onClick={async() => {
						const newMilestone = await addMilestones();
						updatePR({ milestone: newMilestone.added});
					}}>{plusIcon}</button>
				) : null}
			</div>
			<div className='section-item label'>
				{milestone ? (milestone.title): (null)}
			</div>
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
