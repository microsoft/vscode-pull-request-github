

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import React = require('react');
import { ReviewState } from '../../src/github/interface';
import PullRequestContext from '../common/context';
import { nbsp } from './space';
import { cloneElement, useContext, useState } from 'react';
import { Avatar, AuthorLink } from './user';
import { pendingIcon, commentIcon, checkIcon, diffIcon, deleteIcon } from './icon';

export function Reviewer(reviewState: ReviewState & { canDelete: boolean }) {
	const { reviewer, state, canDelete } = reviewState;
	const [showDelete, setShowDelete] = useState(false);
	const { removeReviewer } = useContext(PullRequestContext);
	return <div className='section-item reviewer'
		onMouseEnter={state === 'REQUESTED' ? () => setShowDelete(true) : null}
		onMouseLeave={state === 'REQUESTED' ? () => setShowDelete(false) : null}>
		<Avatar for={reviewer} />
		<AuthorLink for={reviewer} />
		{canDelete && showDelete ? <>{nbsp}<a className='remove-item' onClick={() => removeReviewer(reviewState.reviewer.login)}>{deleteIcon}️</a></> : null}
		{REVIEW_STATE[state]}
	</div>;
}

const REVIEW_STATE: { [state: string]: React.ReactElement } = {
	REQUESTED: cloneElement(pendingIcon, { className: 'push-right', title: 'Awaiting requested review' }),
	COMMENTED: cloneElement(commentIcon, { className: 'push-right', Root: 'div', title: 'Left review comments' }),
	APPROVED: cloneElement(checkIcon, { className: 'push-right', title: 'Approved these changes' }),
	CHANGES_REQUESTED: cloneElement(diffIcon, { className: 'push-right', title: 'Requested changes' }),
};