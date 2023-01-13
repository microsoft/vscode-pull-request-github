/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import React, { cloneElement } from 'react';
import { ReviewState } from '../../src/github/interface';
import { checkIcon, commentIcon, pendingIcon, requestChanges } from './icon';
import { AuthorLink, Avatar } from './user';

export function Reviewer(reviewState: ReviewState & { canDelete: boolean }) {
	const { reviewer, state } = reviewState;
	return (
		<div className="section-item reviewer">
			<div className="avatar-with-author">
				<Avatar for={reviewer} />
				<AuthorLink for={reviewer} />
			</div>
			<div className="reviewer-icons">
				{REVIEW_STATE[state]}
			</div>
		</div>
	);
}

const REVIEW_STATE: { [state: string]: React.ReactElement } = {
	REQUESTED: cloneElement(pendingIcon, { className: 'section-icon requested', title: 'Awaiting requested review' }),
	COMMENTED: cloneElement(commentIcon, { className: 'section-icon commented', Root: 'div', title: 'Left review comments' }),
	APPROVED: cloneElement(checkIcon, { className: 'section-icon approved', title: 'Approved these changes' }),
	CHANGES_REQUESTED: cloneElement(requestChanges, { className: 'section-icon changes', title: 'Requested changes' }),
};
