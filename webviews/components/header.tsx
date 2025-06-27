/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import React, { useContext, useState } from 'react';
import { copilotEventToStatus, CopilotPRStatus, mostRecentCopilotEvent } from '../../src/common/copilot';
import { CopilotStartedEvent, TimelineEvent } from '../../src/common/timelineEvent';
import { GithubItemStateEnum } from '../../src/github/interface';
import { PullRequest } from '../../src/github/views';
import PullRequestContext from '../common/context';
import { useStateProp } from '../common/hooks';
import { checkIcon, issueClosedIcon, issueIcon, mergeIcon, prClosedIcon, prDraftIcon, prOpenIcon } from './icon';
import { nbsp } from './space';
import { AuthorLink, Avatar } from './user';

export function Header({
	canEdit,
	state,
	head,
	base,
	title,
	titleHTML,
	number,
	url,
	author,
	isCurrentlyCheckedOut,
	isDraft,
	isIssue,
	repositoryDefaultBranch,
	events
}: PullRequest) {
	const [currentTitle, setCurrentTitle] = useStateProp(title);
	const [inEditMode, setEditMode] = useState(false);

	return (
		<>
			<Title
				title={currentTitle}
				titleHTML={titleHTML}
				number={number}
				url={url}
				inEditMode={inEditMode}
				setEditMode={setEditMode}
				setCurrentTitle={setCurrentTitle}
			/>
			<Subtitle state={state} head={head} base={base} author={author} isIssue={isIssue} isDraft={isDraft} />
			<div className="header-actions">
				<ButtonGroup
					isCurrentlyCheckedOut={isCurrentlyCheckedOut}
					isIssue={isIssue}
					canEdit={canEdit}
					repositoryDefaultBranch={repositoryDefaultBranch}
					setEditMode={setEditMode}
				/>
				<CancelCodingAgentButton canEdit={canEdit} codingAgentEvent={mostRecentCopilotEvent(events)} />
			</div>
		</>
	);
}

function Title({ title, titleHTML, number, url, inEditMode, setEditMode, setCurrentTitle }) {
	const { setTitle } = useContext(PullRequestContext);

	const titleForm = (
		<form
			className="editing-form title-editing-form"
			onSubmit={async evt => {
				evt.preventDefault();
				try {
					const txt = (evt.target as any)[0].value;
					await setTitle(txt);
					setCurrentTitle(txt);
				} finally {
					setEditMode(false);
				}
			}}
		>
			<input type="text" style={{ width: '100%' }} defaultValue={title} ></input>
			<div className="form-actions">
				<button type="button" className="secondary" onClick={() => setEditMode(false)}>
					Cancel
				</button>
				<button type="submit">Update</button>
			</div>
		</form>
	);

	const displayTitle = (
		<div className="overview-title">
			<h2>
				<span dangerouslySetInnerHTML={{ __html: titleHTML }} />
				{' '}
				<a href={url} title={url}>
					#{number}
				</a>
			</h2>
		</div>
	);

	const editableTitle = inEditMode ? titleForm : displayTitle;
	return editableTitle;
}

function ButtonGroup({ isCurrentlyCheckedOut, canEdit, isIssue, repositoryDefaultBranch, setEditMode }) {
	const { refresh, copyPrLink, copyVscodeDevLink, openChanges } = useContext(PullRequestContext);

	return (
		<div className="button-group">
			<CheckoutButtons {...{ isCurrentlyCheckedOut, isIssue, repositoryDefaultBranch }} />
			{!isIssue && (
				<button title="Open Changes" onClick={openChanges} className="small-button">
					Open Changes
				</button>
			)}
			<button title="Refresh with the latest data from GitHub" onClick={refresh} className="secondary small-button">
				Refresh
			</button>
			{canEdit && (
				<>
					<button title="Rename" onClick={setEditMode} className="secondary small-button">
						Rename
					</button>
					<button title="Copy GitHub pull request link" onClick={copyPrLink} className="secondary small-button">
						Copy Link
					</button>
					<button title="Copy vscode.dev link for viewing this pull request in VS Code for the Web" onClick={copyVscodeDevLink} className="secondary small-button">
						Copy vscode.dev Link
					</button>
				</>
			)}
		</div>
	);
}

function CancelCodingAgentButton({ canEdit, codingAgentEvent }: { canEdit: boolean, codingAgentEvent: TimelineEvent | undefined }) {
	const { cancelCodingAgent, updatePR, openSessionLog } = useContext(PullRequestContext);
	const [isBusy, setBusy] = useState(false);

	const cancel = async () => {
		if (!codingAgentEvent) {
			return;
		}
		setBusy(true);
		const result = await cancelCodingAgent(codingAgentEvent);
		if (result.events.length > 0) {
			updatePR(result);
		}
		setBusy(false);
	};

	// Extract sessionLink from the coding agent event
	const sessionLink = (codingAgentEvent as CopilotStartedEvent)?.sessionLink;

	return (canEdit && codingAgentEvent && copilotEventToStatus(codingAgentEvent) === CopilotPRStatus.Started)
		? <div className="button-group">
			{sessionLink && (
				<button title="View Session" className="secondary small-button" onClick={() => openSessionLog(sessionLink)}>
					View Session
				</button>
			)}
			<button title="Cancel Coding Agent" disabled={isBusy} className="small-button danger" onClick={cancel}>
				Cancel Coding Agent
			</button>
		</div>
		: null;
}

function Subtitle({ state, isDraft, isIssue, author, base, head }) {
	const { text, color, icon } = getStatus(state, isDraft, isIssue);

	return (
		<div className="subtitle">
			<div id="status" className={`status-badge-${color}`}>
				<span className='icon'>{icon}</span>
				<span>{text}</span>
			</div>
			<div className="author">
				{<Avatar for={author} />}
				<div className="merge-branches">
					<AuthorLink for={author} /> {!isIssue ? (<>
						{getActionText(state)} into{' '}
						<code className="branch-tag">{base}</code> from <code className="branch-tag">{head}</code>
					</>) : null}
				</div>
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
				<button
					aria-live="polite"
					title="Switch to a different branch than this pull request branch"
					disabled={isBusy}
					className='small-button'
					onClick={() => onClick('exitReviewMode')}
				>
					{checkIcon}{nbsp} Checkout '{repositoryDefaultBranch}'
				</button>
			</>
		);
	} else if (!isIssue) {
		return (
			<button
				aria-live="polite"
				title="Checkout a local copy of this pull request branch to verify or edit changes"
				disabled={isBusy}
				className='small-button'
				onClick={() => onClick('checkout')}
			>
				Checkout
			</button>
		);
	} else {
		return null;
	}
};

export function getStatus(state: GithubItemStateEnum, isDraft: boolean, isIssue: boolean) {
	const closed = isIssue ? issueClosedIcon : prClosedIcon;
	const open = isIssue ? issueIcon : prOpenIcon;

	if (state === GithubItemStateEnum.Merged) {
		return { text: 'Merged', color: 'merged', icon: mergeIcon };
	} else if (state === GithubItemStateEnum.Open) {
		return isDraft ? { text: 'Draft', color: 'draft', icon: prDraftIcon } : { text: 'Open', color: 'open', icon: open };
	} else {
		return { text: 'Closed', color: 'closed', icon: closed };
	}
}

function getActionText(state: GithubItemStateEnum) {
	if (state === GithubItemStateEnum.Merged) {
		return 'merged changes';
	} else {
		return 'wants to merge changes';
	}
}
