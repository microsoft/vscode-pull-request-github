/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import React, { useContext, useState } from 'react';
import { GithubItemStateEnum } from '../../src/github/interface';
import { PullRequest } from '../common/cache';
import PullRequestContext from '../common/context';
import { useStateProp } from '../common/hooks';
import { checkIcon } from './icon';
import { Timestamp } from './timestamp';
import { AuthorLink, Avatar } from './user';

export function Header({
	canEdit,
	state,
	head,
	base,
	title,
	number,
	url,
	author,
	isCurrentlyCheckedOut,
	isDraft,
	isIssue,
	repositoryDefaultBranch,
}: PullRequest) {
	return (
		<Title
			{...{
				title,
				number,
				url,
				canEdit,
				isCurrentlyCheckedOut,
				isIssue,
				repositoryDefaultBranch,
				state,
				head,
				base,
				author,
				isDraft,
			}}
		/>
	);
}

function Subtitle({ state, isDraft, isIssue, author, base, head }) {
	return (
		<div className="subtitle">
			<div id="status">{getStatus(state, isDraft)}</div>
			{!isIssue ? <Avatar for={author} /> : null}
			<span className="author">
				{!isIssue ? (
					<div>
						<AuthorLink for={author} /> {getActionText(state)} into{' '}
						<code className="branch-tag"> {base}</code> from <code className="branch-tag"> {head} </code>
					</div>
				) : null}
			</span>
		</div>
	);
}

function Title({
	title,
	number,
	url,
	canEdit,
	isCurrentlyCheckedOut,
	isIssue,
	repositoryDefaultBranch,
	state,
	head,
	base,
	author,
	isDraft,
}: PullRequest) {
	const [inEditMode, setEditMode] = useState(false);
	const [currentTitle, setCurrentTitle] = useStateProp(title);
	const { setTitle, refresh, copyPrLink } = useContext(PullRequestContext);
	const editableTitle = inEditMode ? (
		<form
			className="editing-form title-editing-form"
			onSubmit={async evt => {
				evt.preventDefault();
				try {
					const txt = (evt.target as any).text.value;
					await setTitle(txt);
					setCurrentTitle(txt);
				} finally {
					setEditMode(false);
				}
			}}
		>
			<textarea name="text" style={{ width: '100%' }} defaultValue={currentTitle}></textarea>
			<div className="form-actions">
				<button className="secondary" onClick={() => setEditMode(false)}>
					Cancel
				</button>
				<input type="submit" value="Update" />
			</div>
		</form>
	) : (
		<h2>
			{currentTitle}{' '}
			<a href={url} title={url}>
				#{number}
			</a>
		</h2>
	);

	return (
		<div className="overview-title">
			<div className="title-and-edit">
				{editableTitle}
				<div className="block-select">
					{/*
				For whatever reason, triple click on a block element in MacOS will select everything in that element, *and* every `user-select: false` block adjacent to that element.
				Add an empty selectable div here to block triple click on title from selecting the following buttons. Issue #628.
				*/}
				</div>
			</div>
			<Subtitle state={state} head={head} base={base} author={author} isIssue={isIssue} isDraft={isDraft} />
			<div className="button-group">
				<CheckoutButtons {...{ isCurrentlyCheckedOut, isIssue, repositoryDefaultBranch }} />
				<button onClick={refresh} className="secondary">
					Refresh
				</button>
				{canEdit && !inEditMode ? (
					<>
						<button title="Edit" onClick={() => setEditMode(true)} className="secondary">
							Rename
						</button>
						<button title="Copy Link" onClick={copyPrLink} className="secondary">
							Copy Link
						</button>
					</>
				) : (
					<div className="flex-action-bar comment-actions"></div>
				)}
			</div>
		</div>
	);
}

const CheckoutButtons = ({ isCurrentlyCheckedOut, isIssue, repositoryDefaultBranch }) => {
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
		return (
			<>
				<button aria-live="polite" className="checkedOut" disabled>
					{checkIcon} Checked Out
				</button>
				<button
					aria-live="polite"
					title="Switch to a different branch than this pull request branch"
					disabled={isBusy}
					onClick={() => onClick('exitReviewMode')}
				>
					Checkout '{repositoryDefaultBranch}'
				</button>
			</>
		);
	} else if (!isIssue) {
		return (
			<button
				aria-live="polite"
				title="Checkout a local copy of this pull request branch to verify or edit changes"
				disabled={isBusy}
				onClick={() => onClick('checkout')}
			>
				Checkout
			</button>
		);
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
