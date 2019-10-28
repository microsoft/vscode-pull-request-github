import * as React from 'react';
import { useContext, useState } from 'react';

import { PullRequest } from './cache';
import { Avatar, AuthorLink } from './user';
import { Spaced } from './space';
import PullRequestContext from './context';
import { checkIcon, editIcon } from './icon';
import Timestamp from './timestamp';
import { PullRequestStateEnum } from '../src/github/interface';
import { useStateProp } from './hooks';

export function Header({ canEdit, state, head, base, title, number, url, createdAt, author, isCurrentlyCheckedOut, isDraft, }: PullRequest) {
	return <>
		<Title {...{title, number, url, canEdit, isCurrentlyCheckedOut}} />
		<div className='subtitle'>
			<div id='status'>{getStatus(state, isDraft)}</div>
			<Avatar for={author} />
			<span className='author'>
				<Spaced>
					<AuthorLink for={author} />
					{getActionText(state)}
					into <code>{base}</code>
					from <code>{head}</code>
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

function Title({ title, number, url, canEdit, isCurrentlyCheckedOut }: Partial<PullRequest>) {
	const [ inEditMode, setEditMode ] = useState(false);
	const [ showActionBar, setShowActionBar ] = useState(false);
	const [ currentTitle, setCurrentTitle ] = useStateProp(title);
	const { setTitle, refresh } = useContext(PullRequestContext);
	const editableTitle =
		inEditMode
			?
				<form
					className='editing-form title-editing-form'
					onSubmit={
						async evt => {
							evt.preventDefault();
							try {
								const txt = (evt.target as any).text.value;
								await setTitle(txt);
								setCurrentTitle(txt);
							} finally {
								setEditMode(false);
							}
						}
					}
				>
				<textarea name='text' style={{ width: '100%' }} defaultValue={currentTitle}></textarea>
				<div className='form-actions'>
					<button className='secondary'
						onClick={() => setEditMode(false)}>Cancel</button>
					<input type='submit' value='Update' />
				</div>
			</form>
		:
			<h2>
				{currentTitle} (<a href={url}>#{number}</a>)
			</h2>;

	return <div className='overview-title'
		onMouseEnter={() => setShowActionBar(true)}
		onMouseLeave={() => setShowActionBar(false)}>
		{editableTitle}
		<div className='block-select'>
			{/*
			  For whatever reason, triple click on a block element in MacOS will select everything in that element, *and* every `user-select: false` block adjacent to that element.
			  Add an empty selectable div here to block triple click on title from selecting the following buttons. Issue #628.
			*/}
		</div>
		{
			(canEdit && showActionBar && !inEditMode)
				? <div className='flex-action-bar comment-actions'>
						{<button onClick={() => setEditMode(true)}>{editIcon}</button>}
					</div>
				: null
		}
		<div className='button-group'>
			<CheckoutButtons {...{isCurrentlyCheckedOut}} />
			<button onClick={refresh}>Refresh</button>
		</div>
	</div>;
}

const CheckoutButtons = ({ isCurrentlyCheckedOut }) => {
	const { exitReviewMode, checkout } = useContext(PullRequestContext);
	const [ isBusy, setBusy ] = useState(false);

	const onClick = async (command: string) => {
		try {
			setBusy(true);

			switch (command) {
				case 'checkout':
					await checkout();
					break;
				case 'exitReviewMode':
					await exitReviewMode();
					break;
				default:
					throw new Error(`Can't find action ${command}`);
			}
		} finally {
			setBusy(false);
		}
	};

	if (isCurrentlyCheckedOut) {
		return <>
			<button aria-live='polite' className='checkedOut' disabled>{checkIcon} Checked Out</button>
			<button aria-live='polite' disabled={isBusy} onClick={() => onClick('exitReviewMode')}>Exit Review Mode</button>
		</>;
	} else {
		return <button aria-live='polite' disabled={isBusy} onClick={() => onClick('checkout')}>Checkout</button>;
	}
};

export function getStatus(state: PullRequestStateEnum, isDraft: boolean) {
	if (state === PullRequestStateEnum.Merged) {
		return 'Merged';
	} else if (state === PullRequestStateEnum.Open) {
		return isDraft ? 'Draft' : 'Open';
	} else {
		return 'Closed';
	}
}

function getActionText(state: PullRequestStateEnum) {
	if (state === PullRequestStateEnum.Merged) {
		return 'merged changes';
	} else {
		return 'wants to merge changes';
	}
}