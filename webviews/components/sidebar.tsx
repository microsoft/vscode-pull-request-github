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

export default function Sidebar({ reviewers, labels, hasWritePermission, isIssue }: PullRequest) {
	const { addReviewers, addLabels, updatePR, pr } = useContext(PullRequestContext);

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
				labels.map(label => <Label key={label.name} {...label} canDelete={hasWritePermission} />)
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
