/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as React from 'react';
// eslint-disable-next-line no-duplicate-imports
import { cloneElement, useContext, useState } from 'react';
import { PullRequestVote, ReviewState } from '../../src/azdo/interface';
import PullRequestContext from '../common/context';
import { checkIcon, deleteIcon, pendingIcon } from './icon';
import { VoteText } from './sidebar';
import { nbsp } from './space';
import { AuthorLink, Avatar } from './user';

export function Reviewer(reviewState: ReviewState & { canDelete: boolean }) {
	const { reviewer, state, canDelete } = reviewState;
	const [showDelete, setShowDelete] = useState(false);
	const { removeReviewer } = useContext(PullRequestContext);
	return (
		<div
			className="section-item reviewer"
			onMouseEnter={state === PullRequestVote.NO_VOTE ? () => setShowDelete(true) : null}
			onMouseLeave={state === PullRequestVote.NO_VOTE ? () => setShowDelete(false) : null}
		>
			<Avatar url={reviewer.url} avatarUrl={reviewer.avatarUrl} />
			<AuthorLink url={reviewer.url} text={reviewer.name} />
			{canDelete && showDelete ? (
				<>
					{nbsp}
					<a className="remove-item" onClick={() => removeReviewer(reviewState.reviewer.id)}>
						{deleteIcon}️
					</a>
				</>
			) : null}
			{REVIEW_STATE[state?.toString() ?? PullRequestVote.NO_VOTE.toString()]}
		</div>
	);
}

const REVIEW_STATE: { [state: string]: React.ReactElement } = {
	'10': cloneElement(checkIcon, { className: 'push-right', title: VoteText['10'] }),
	'5': cloneElement(checkIcon, { className: 'push-right', title: VoteText['5'] }),
	'-5': cloneElement(pendingIcon, { className: 'push-right', title: VoteText['-5'] }),
	'-10': cloneElement(deleteIcon, { className: 'push-right', title: VoteText['-10'] }),
	'0': cloneElement(pendingIcon, { className: 'push-right', title: VoteText['0'] }),
};
