/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import React, { cloneElement, useContext } from 'react';
import { ReviewState } from '../../src/github/interface';
import PullRequestContext from '../common/context';
import { checkIcon, commentIcon, pendingIcon, requestChanges, syncIcon } from './icon';
import { AuthorLink, Avatar } from './user';

export function Reviewer(reviewState: ReviewState) {
	const { reviewer, state } = reviewState;
	const { reRequestReview } = useContext(PullRequestContext);

	return (
		<div className="section-item reviewer">
			<div className="avatar-with-author">
				<Avatar for={reviewer} />
				<AuthorLink for={reviewer} />
			</div>
			<div className="reviewer-icons">
				{
					state !== 'REQUESTED' ?
						(<button className="icon-button" title="Re-request review" onClick={() => reRequestReview(reviewState.reviewer.login)}>
							{syncIcon}️
						</button>) : null
				}
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
