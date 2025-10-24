/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import React, { useContext, useState } from 'react';
import { ContextDropdown } from './contextDropdown';
import { copilotErrorIcon, copilotInProgressIcon, copilotSuccessIcon, copyIcon, editIcon, gitMergeIcon, gitPullRequestClosedIcon, gitPullRequestDraftIcon, gitPullRequestIcon, issuescon, loadingIcon, passIcon } from './icon';
import { AuthorLink, Avatar } from './user';
import { copilotEventToStatus, CopilotPRStatus, mostRecentCopilotEvent } from '../../src/common/copilot';
import { CopilotStartedEvent, TimelineEvent } from '../../src/common/timelineEvent';
import { GithubItemStateEnum, StateReason } from '../../src/github/interface';
import { CodingAgentContext, OverviewContext, PullRequest } from '../../src/github/views';
import PullRequestContext from '../common/context';
import { useStateProp } from '../common/hooks';

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
	events,
	owner,
	repo,
	busy,
	stateReason
}: PullRequest) {
	const [currentTitle, setCurrentTitle] = useStateProp(title);
	const [inEditMode, setEditMode] = useState(false);
	const codingAgentEvent = mostRecentCopilotEvent(events);

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
				canEdit={canEdit}
				owner={owner}
				repo={repo}
			/>
			<Subtitle state={state} stateReason={stateReason} head={head} base={base} author={author} isIssue={isIssue} isDraft={isDraft} codingAgentEvent={codingAgentEvent} />
			<div className="header-actions">
				<ButtonGroup
					isCurrentlyCheckedOut={isCurrentlyCheckedOut}
					isIssue={isIssue}
					repositoryDefaultBranch={repositoryDefaultBranch}
					owner={owner}
					repo={repo}
					number={number}
					busy={busy}
				/>
				<CancelCodingAgentButton canEdit={canEdit} codingAgentEvent={codingAgentEvent} />
			</div>
		</>
	);
}

interface TitleProps {
	title: string;
	titleHTML: string;
	number: number;
	url: string;
	inEditMode: boolean;
	setEditMode: React.Dispatch<React.SetStateAction<boolean>>;
	setCurrentTitle: React.Dispatch<React.SetStateAction<string>>;
	canEdit: boolean;
	owner: string;
	repo: string;
}

function Title({ title, titleHTML, number, url, inEditMode, setEditMode, setCurrentTitle, canEdit, owner, repo }: TitleProps): JSX.Element {
	const { setTitle, copyPrLink } = useContext(PullRequestContext);

	const titleForm = (
		<form
			className="editing-form title-editing-form"
			onSubmit={async evt => {
				evt.preventDefault();
				try {
					const form = evt.currentTarget;
					const firstElement = form.elements[0] as HTMLInputElement | undefined;
					const txt = firstElement ? firstElement.value : '';
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

	const context: OverviewContext = {
		'preventDefaultContextMenuItems': true,
		owner,
		repo,
		number
	};
	context['github:copyMenu'] = true;

	const displayTitle = (
		<div className="overview-title">
			<h2>
				<span dangerouslySetInnerHTML={{ __html: titleHTML }} />
				{' '}
				<a href={url} title={url} data-vscode-context={JSON.stringify(context)}>
					#{number}
				</a>
			</h2>
			{canEdit ?
				<button title="Rename" onClick={() => setEditMode(true)} className="icon-button">
					{editIcon}
				</button>
				: null}
			<button title="Copy Link" onClick={copyPrLink} className="icon-button" aria-label="Copy Pull Request Link">
				{copyIcon}
			</button>
		</div>
	);

	const editableTitle = inEditMode ? titleForm : displayTitle;
	return editableTitle;
}

interface ButtonGroupProps {
	isCurrentlyCheckedOut: boolean;
	isIssue: boolean;
	repositoryDefaultBranch: string;
	owner: string;
	repo: string;
	number: number;
	busy?: boolean;
}

function ButtonGroup({ isCurrentlyCheckedOut, isIssue, repositoryDefaultBranch, owner, repo, number, busy }: ButtonGroupProps): JSX.Element {
	const { refresh } = useContext(PullRequestContext);

	return (
		<div className="button-group">
			<CheckoutButton {...{ isCurrentlyCheckedOut, isIssue, repositoryDefaultBranch, owner, repo, number }} />
			<button title="Refresh with the latest data from GitHub" onClick={refresh} className="secondary">
				Refresh
			</button>
			{busy ? (
				<div className='spinner'>
					{loadingIcon}
				</div>
			) : null}
		</div>
	);
}

function CancelCodingAgentButton({ canEdit, codingAgentEvent }: { canEdit: boolean; codingAgentEvent: TimelineEvent | undefined }): JSX.Element | null {
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

	if (!codingAgentEvent || copilotEventToStatus(codingAgentEvent) !== CopilotPRStatus.Started) {
		return null;
	}

	const context: CodingAgentContext = {
		'preventDefaultContextMenuItems': true,
		...sessionLink
	};

	context['github:codingAgentMenu'] = true;
	const actions: { label: string; value: string; action: (event: React.MouseEvent<HTMLButtonElement, MouseEvent>) => void }[] = [];

	if (sessionLink) {
		actions.push({
			label: 'View Session',
			value: '',
			action: () => openSessionLog(sessionLink)
		});
	}

	if (canEdit) {
		actions.unshift({
			label: 'Cancel Coding Agent',
			value: '',
			action: cancel
		});
	}

	return <ContextDropdown
		optionsContext={() => JSON.stringify(context)}
		defaultAction={actions[0].action}
		defaultOptionLabel={() => isBusy ? (
			<>
				<span className='loading-button'>{loadingIcon}</span>
				{actions[0].label}
			</>
		) : actions[0].label}
		defaultOptionValue={() => actions[0].value}
		allOptions={() => {
			return actions;
		}}
		optionsTitle={actions[0].label}
		disabled={isBusy}
		hasSingleAction={false}
		spreadable={false}
		isSecondary={true}
	/>;
}

interface SubtitleProps {
	state: GithubItemStateEnum;
	stateReason?: StateReason;
	isDraft?: boolean;
	isIssue: boolean;
	author: PullRequest['author'];
	base: string;
	head: string;
	codingAgentEvent: TimelineEvent | undefined;
}

function Subtitle({ state, stateReason, isDraft, isIssue, author, base, head, codingAgentEvent }: SubtitleProps): JSX.Element {
	const { text, color, icon } = getStatus(state, !!isDraft, isIssue, stateReason);
	const copilotStatus = copilotEventToStatus(codingAgentEvent);
	let copilotStatusIcon: JSX.Element | undefined;
	if (copilotStatus === CopilotPRStatus.Started) {
		copilotStatusIcon = copilotInProgressIcon;
	} else if (copilotStatus === CopilotPRStatus.Completed) {
		copilotStatusIcon = copilotSuccessIcon;
	} else if (copilotStatus === CopilotPRStatus.Failed) {
		copilotStatusIcon = copilotErrorIcon;
	}

	return (
		<div className="subtitle">
			<div id="status" className={`status-badge-${color}`}>
				<span className='icon'>{icon}</span>
				<span>{text}</span>
			</div>
			<div className="author">
				{<Avatar for={author} substituteIcon={copilotStatusIcon} />}
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

interface CheckoutButtonProps {
	isCurrentlyCheckedOut: boolean;
	isIssue: boolean;
	repositoryDefaultBranch: string;
	owner: string;
	repo: string;
	number: number;
}

const CheckoutButton: React.FC<CheckoutButtonProps> = ({ isCurrentlyCheckedOut, isIssue, repositoryDefaultBranch, owner, repo, number }) => {
	const { exitReviewMode, checkout, openChanges } = useContext(PullRequestContext);
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
				case 'openChanges':
					await openChanges();
					break;
				default:
					throw new Error(`Can't find action ${command}`);
			}
		} finally {
			setBusy(false);
		}
	};

	if (isIssue) {
		return null;
	}

	const context: OverviewContext = {
		'preventDefaultContextMenuItems': true,
		owner,
		repo,
		number
	};

	context['github:checkoutMenu'] = true;
	const actions: { label: string; value: string; action: (event: React.MouseEvent<HTMLButtonElement, MouseEvent>) => void }[] = [];

	if (isCurrentlyCheckedOut) {
		actions.push({
			label: `Checkout '${repositoryDefaultBranch}'`,
			value: '',
			action: () => onClick('exitReviewMode')
		});
	} else {
		actions.push({
			label: 'Checkout',
			value: '',
			action: () => onClick('checkout')
		});
	}

	actions.push({
		label: 'Open Changes',
		value: '',
		action: () => onClick('openChanges')
	});

	return <ContextDropdown
		optionsContext={() => JSON.stringify(context)}
		defaultAction={actions[0].action}
		defaultOptionLabel={() => actions[0].label}
		defaultOptionValue={() => actions[0].value}
		allOptions={() => {
			return actions;
		}}
		optionsTitle={actions[0].label}
		disabled={isBusy}
		hasSingleAction={false}
		spreadable={false}
	/>;
};

export function getStatus(state: GithubItemStateEnum, isDraft: boolean, isIssue: boolean, stateReason?: StateReason) {
	const closed = isIssue ? passIcon : gitPullRequestClosedIcon;
	const open = isIssue ? issuescon : gitPullRequestIcon;

	if (state === GithubItemStateEnum.Merged) {
		return { text: 'Merged', color: 'merged', icon: gitMergeIcon };
	} else if (state === GithubItemStateEnum.Open) {
		return isDraft ? { text: 'Draft', color: 'draft', icon: gitPullRequestDraftIcon } : { text: 'Open', color: 'open', icon: open };
	} else {
		let closedColor: string = 'closed';
		if (isIssue) {
			closedColor = stateReason !== 'COMPLETED' ? 'draft' : 'merged';
		}
		return { text: 'Closed', color: closedColor, icon: closed };
	}
}

function getActionText(state: GithubItemStateEnum) {
	if (state === GithubItemStateEnum.Merged) {
		return 'merged changes';
	} else {
		return 'wants to merge changes';
	}
}
