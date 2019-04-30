import * as React from 'react';
import { useContext, useState } from 'react';

import { PullRequest } from './cache';
import { Avatar, AuthorLink } from './user';
import { Spaced } from './space';
import PullRequestContext from './context';
import { checkIcon, editIcon } from './icon';
import Timestamp from './timestamp';
import { PullRequestStateEnum } from '../src/github/interface';

export function Header({ canEdit, state, head, base, title, number, url, createdAt, author, isCurrentlyCheckedOut, }: PullRequest) {
	const { refresh } = useContext(PullRequestContext);
	return <>
		<div className='overview-title'>
			<Title {...{title, number, url, canEdit}} />
			<div className='button-group'>
				<CheckoutButtons {...{isCurrentlyCheckedOut}} />
				<button onClick={refresh}>Refresh</button>
			</div>
		</div>
		<div className='subtitle'>
			<div id='status'>{getStatus(state)}</div>
			<Avatar for={author} />
			<span className='author'>
				<Spaced>
					<AuthorLink for={author} /> wants to merge changes
					from <code>{head}</code>
					to <code>{base}</code>
				</Spaced>.
			</span>
			<span className='created-at'>
				<Spaced>
					Created <Timestamp date={createdAt} href={url} />
				</Spaced>
			</span>
		</div>
	</>;
}

function Title({ title, number, url, canEdit }: Partial<PullRequest>) {
	const [ inEditMode, setEditMode ] = useState(false);
	const [ showActionBar, setShowActionBar ] = useState(false);
	const { setTitle } = useContext(PullRequestContext);
	if (inEditMode) {
		return <form
				className='editing-form'
				onSubmit={
					async evt => {
						evt.preventDefault();
						try {
							await setTitle((evt.target as any).text.value);
						} finally {
							setEditMode(false);
						}
					}
				}
			>
			<textarea name='text'></textarea>
			<div className='form-actions'>
				<button>Cancel</button>
				<input type='submit' value='Update' />
			</div>
		</form>;
	}
	return <h2 className='pull-request-title'
			onMouseEnter={() => setShowActionBar(true)}
			onMouseLeave={() => setShowActionBar(false)}
		>
		{title} (<a href={url}>#{number}</a>)
		{
			(canEdit && showActionBar)
				? <div className='action-bar comment-actions'>
						{canEdit ? <button onClick={() => setEditMode(true)}>{editIcon}</button> : null}
					</div>
				: null
		}
	</h2>;
}

const CheckoutButtons = ({ isCurrentlyCheckedOut }) => {
	const { exitReviewMode, checkout } = useContext(PullRequestContext);
	if (isCurrentlyCheckedOut) {
		return <>
			<button aria-live='polite' className='checkedOut' disabled>{checkIcon} Checked Out</button>
			<button aria-live='polite' onClick={exitReviewMode}>Exit Review Mode</button>
		</>;
	} else {
		return <button aria-live='polite' onClick={checkout}>Checkout</button>;
	}
};

export function getStatus(state: PullRequestStateEnum) {
	if (state === PullRequestStateEnum.Merged) {
		return 'Merged';
	} else if (state === PullRequestStateEnum.Open) {
		return 'Open';
	} else {
		return 'Closed';
	}
}