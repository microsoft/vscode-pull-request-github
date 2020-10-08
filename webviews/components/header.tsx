/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import { useContext, useState } from 'react';

import { PullRequest } from '../common/cache';
import { Avatar, AuthorLink } from './user';
import { Spaced } from './space';
import PullRequestContext from '../common/context';
import { checkIcon, editIcon,copyIcon } from './icon';
import Timestamp from './timestamp';
import { GithubItemStateEnum } from '../../src/github/interface';
import { useStateProp } from '../common/hooks';

export function Header({ canEdit, state, head, base, title, number, url, createdAt, author, isCurrentlyCheckedOut, isDraft, isIssue }: PullRequest) {
	return <>
		<Title {...{ title, number, url, canEdit, isCurrentlyCheckedOut, isIssue }} />
		<div className='subtitle'>
			<div id='status'>{getStatus(state, isDraft)}</div>
			{(!isIssue)
				? <Avatar for={author} />
				: null}
			<span className='author'>
				{(!isIssue)
					? <Spaced>
						<AuthorLink for={author} />
						{getActionText(state)}
						into <code>{base}</code>
						from <code>{head}</code>
					</Spaced>
					: null}
			</span>
			<span className='created-at'>
				<Spaced>
					Created <Timestamp date={createdAt} href={url} />
				</Spaced>
			</span>
		</div>
	</>;
}

function Title({ title, number, url, canEdit, isCurrentlyCheckedOut, isIssue }: Partial<PullRequest>) {
	const [inEditMode, setEditMode] = useState(false);
	const [showActionBar, setShowActionBar] = useState(false);
	const [currentTitle, setCurrentTitle] = useStateProp(title);
	const { setTitle, refresh,copyPrLink } = useContext(PullRequestContext);
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
					{<button title='Edit' onClick={() => setEditMode(true)}>{editIcon}</button>}
					{<button title='Copy Link' onClick={copyPrLink}>{copyIcon}</button>}
				</div>
				: <div className='flex-action-bar comment-actons'></div>
		}
		<div className='button-group'>
			<CheckoutButtons {...{ isCurrentlyCheckedOut, isIssue }} />
			<button onClick={refresh}>Refresh</button>
		</div>
	</div>;
}

const CheckoutButtons = ({ isCurrentlyCheckedOut, isIssue }) => {
	const { exitReviewMode, checkout } = useContext(PullRequestContext);
	const [isBusy, setBusy] = useState(false);

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
	} else if (!isIssue) {
		return <button aria-live='polite' disabled={isBusy} onClick={() => onClick('checkout')}>Checkout</button>;
	} else {
		return null;
	}
};

export function getStatus(state: GithubItemStateEnum, isDraft: boolean) {
	if (state === GithubItemStateEnum.Merged) {
		return 'Merged';
	} else if (state === GithubItemStateEnum.Open) {
		return isDraft ? 'Draft' : 'Open';
	} else {
		return 'Closed';
	}
}

function getActionText(state: GithubItemStateEnum) {
	if (state === GithubItemStateEnum.Merged) {
		return 'merged changes';
	} else {
		return 'wants to merge changes';
	}
}
