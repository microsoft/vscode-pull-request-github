/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSCodeButton } from '@vscode/webview-ui-toolkit/react';
import React, { useContext, useState } from 'react';
import { GithubItemStateEnum } from '../../src/github/interface';
import { PullRequest } from '../common/cache';
import PullRequestContext from '../common/context';
import { useStateProp } from '../common/hooks';
import { checkIcon, copyIcon, editIcon } from './icon';
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
	createdAt,
	author,
	isCurrentlyCheckedOut,
	isDraft,
	isIssue,
	repositoryDefaultBranch
}: PullRequest) {
	return (
		<>
			<Title {...{ title, number, url, canEdit, isCurrentlyCheckedOut, isIssue, repositoryDefaultBranch }} />
			<div className="subtitle">
				<div id="status">{getStatus(state, isDraft)}</div>
				{!isIssue ? <Avatar for={author} /> : null}
				<span className="author">
					{!isIssue ? (
						<div>
							<AuthorLink for={author} /> {getActionText(state)} into <code> {base} </code> from <code> {head} </code>
						</div>
					) : null}
				</span>
				<span className="created-at">
					Created <Timestamp date={createdAt} href={url} />
				</span>
			</div>
		</>
	);
}

function Title({ title, number, url, canEdit, isCurrentlyCheckedOut, isIssue, repositoryDefaultBranch }: Partial<PullRequest>) {
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
			<div className="form-actions button-group">
				<VSCodeButton appearance='secondary' onClick={() => setEditMode(false)}>
					Cancel
				</VSCodeButton>
				<VSCodeButton type="submit">Update</VSCodeButton>
			</div>
		</form>
	) : (
		<h2>
			{currentTitle} <a href={url} title={url}>#{number}</a>
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
				{canEdit && !inEditMode ? (
					<div className="flex-action-bar comment-actions button-group">
						{
							<VSCodeButton appearance='icon' title="Edit" onClick={() => setEditMode(true)}>
								{editIcon}
							</VSCodeButton>
						}
						{
							<VSCodeButton appearance='icon' title="Copy Link" onClick={copyPrLink}>
								{copyIcon}
							</VSCodeButton>
						}
					</div>
				) : (
					<div className="flex-action-bar comment-actions"></div>
				)}
			</div>
			<div className="button-group">
				<CheckoutButtons {...{ isCurrentlyCheckedOut, isIssue, repositoryDefaultBranch }} />
				<VSCodeButton onClick={refresh}>Refresh</VSCodeButton>
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
				<VSCodeButton aria-live="polite" title="Switch to a different branch than this pull request branch"disabled={isBusy} onClick={() => onClick('exitReviewMode')}>
					Checkout '{repositoryDefaultBranch}'
				</VSCodeButton>
			</>
		);
	} else if (!isIssue) {
		return (
			<button aria-live="polite" title="Checkout a local copy of this pull request branch to verify or edit changes" disabled={isBusy} onClick={() => onClick('checkout')}>
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
