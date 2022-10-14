/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import React, { cloneElement, useContext } from 'react';
import { ReviewState } from '../../src/github/interface';
import { default as PullRequestContext } from '../common/context';
import { checkIcon, commentIcon, deleteIcon, diffIcon, pendingIcon } from './icon';
import { AuthorLink, Avatar } from './user';

export function Reviewer(reviewState: ReviewState & { canDelete: boolean }) {
	const { reviewer, state, canDelete } = reviewState;
	const { removeReviewer } = useContext(PullRequestContext);
	return (
		<div className="section-item reviewer">
			<div className="avatar-with-author">
				<Avatar for={reviewer} />
				<AuthorLink for={reviewer} />
			</div>
			<div className="reviewer-icons">
				{canDelete && (
					<button className="icon-button" onClick={() => removeReviewer(reviewState.reviewer.login)}>
						{deleteIcon}️
					</button>
				)}
				{REVIEW_STATE[state]}
			</div>
		</div>
	);
}

const REVIEW_STATE: { [state: string]: React.ReactElement } = {
	REQUESTED: cloneElement(pendingIcon, { className: 'section-icon', title: 'Awaiting requested review' }),
	COMMENTED: cloneElement(commentIcon, { className: 'section-icon', Root: 'div', title: 'Left review comments' }),
	APPROVED: cloneElement(checkIcon, { className: 'section-icon', title: 'Approved these changes' }),
	CHANGES_REQUESTED: cloneElement(diffIcon, { className: 'section-icon', title: 'Requested changes' }),
};
