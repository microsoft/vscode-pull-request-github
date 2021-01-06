/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import { useContext, useState } from 'react';
import { PullRequest } from '../common/cache';
import { plusIcon, deleteIcon } from './icon';
import PullRequestContext from '../common/context';
import { ILabel } from '../../src/azdo/interface';
import { nbsp } from './space';
import { Reviewer } from './reviewer';

export default function Sidebar({ reviewers, labels, hasWritePermission }: PullRequest) {
	const { addReviewers, addLabels, updatePR, pr } = useContext(PullRequestContext);

	return <div id='sidebar'>
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