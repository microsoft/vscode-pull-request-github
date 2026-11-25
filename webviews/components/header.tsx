/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import React, { useContext, useState } from 'react';
import { ContextDropdown } from './contextDropdown';
import { CopyButton } from './copyButton';
import { copilotErrorIcon, copilotInProgressIcon, copilotSuccessIcon, diffMultipleIcon, editIcon, gitMergeIcon, gitPullRequestClosedIcon, gitPullRequestDraftIcon, gitPullRequestIcon, issuescon, loadingIcon, passIcon } from './icon';
import { StackBadge } from './pullRequestStack';
import { AuthorLink, Avatar } from './user';
import { copilotEventToStatus, CopilotPRStatus, mostRecentCopilotEvent } from '../../src/common/copilot';
import { CopilotStartedEvent, SessionLinkInfo, TimelineEvent } from '../../src/common/timelineEvent';
import { GithubItemStateEnum, PullRequestStack, StateReason } from '../../src/github/interface';
import { BaseContext, CodingAgentContext, OverviewContext, OverviewItemPreview, PullRequest } from '../../src/github/views';
import { EDIT_TITLE_BUTTON_ID } from '../common/constants';
import PullRequestContext from '../common/context';
import { useBusyAction, usePendingAction, useStateProp } from '../common/hooks';

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
	isAgentSessionsWorkspace,
	doneCheckoutBranch,
	events,
	owner,
	repo,
	stateReason,
	stack,
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
				isIssue={isIssue}
				owner={owner}
				repo={repo}
			/>
			<Subtitle state={state} stateReason={stateReason} head={head} base={base} author={author} isIssue={isIssue} isDraft={isDraft} codingAgentEvent={codingAgentEvent} canEdit={canEdit} stack={stack} />
			<div className="header-actions">
				<ButtonGroup
					isCurrentlyCheckedOut={isCurrentlyCheckedOut}
					isIssue={isIssue}
					isAgentSessionsWorkspace={!!isAgentSessionsWorkspace}
					doneCheckoutBranch={doneCheckoutBranch}
					owner={owner}
					repo={repo}
					number={number}
				/>
				<CancelCodingAgentButton canEdit={canEdit} codingAgentEvent={codingAgentEvent} />
			</div>
		</>
	);
}

export function HeaderPreview(preview: OverviewItemPreview | PullRequest) {
	const { openOnGitHub } = useContext(PullRequestContext);
	const pullRequest = preview.isIssue === true ? undefined : preview;
	return <>
		<div className="overview-title">
			<TitleText {...preview} onOpen={openOnGitHub} />
		</div>
		<Subtitle
			state={preview.state}
			stateReason={preview.stateReason}
			author={preview.author}
			isDraft={pullRequest?.isDraft}
			base={pullRequest?.base}
			head={pullRequest?.head}
			isIssue={preview.isIssue === true}
			canEdit={false}
			codingAgentEvent={undefined}
		/>
		<div className="header-actions">
			<div className="button-group overview-preview-actions" aria-hidden="true">
				<span className="overview-placeholder" />
				<span className="overview-placeholder" />
			</div>
			<span className="overview-preview-status" role="status">Loading...</span>
		</div>
	</>;
}

function TitleText({ titleHTML, number, url, context, onOpen }: Pick<PullRequest, 'titleHTML' | 'number' | 'url'> & {
	context?: BaseContext;
	onOpen?: () => void;
}) {
	return <h2>
		<span dangerouslySetInnerHTML={{ __html: titleHTML }} />
		{' '}
		<a
			href={url}
			title={url}
			data-vscode-context={context ? JSON.stringify(context) : undefined}
			onClick={onOpen ? event => {
				// The webview host opens any anchor with an href and ignores defaultPrevented,
				// so the click must not reach it or a second browser tab is opened.
				event.preventDefault();
				event.stopPropagation();
				onOpen();
			} : undefined}
		>
			#{number}
		</a>
	</h2>;
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
	isIssue: boolean;
	owner: string;
	repo: string;
}

function Title({ title, titleHTML, number, url, inEditMode, setEditMode, setCurrentTitle, canEdit, isIssue, owner, repo }: TitleProps): JSX.Element {
	const { setTitle, copyPrLink, openOnGitHub } = useContext(PullRequestContext);
	const [isSaving, runSave] = useBusyAction();

	const titleForm = (
		<form
			className="editing-form title-editing-form"
			onSubmit={async evt => {
				evt.preventDefault();
				const firstElement = evt.currentTarget.elements[0] as HTMLInputElement | undefined;
				const txt = firstElement ? firstElement.value : '';
				try {
					await runSave(async () => {
						await setTitle(txt);
						setCurrentTitle(txt);
					});
				} finally {
					setEditMode(false);
				}
			}}
		>
			<input type="text" style={{ width: '100%' }} defaultValue={title} ></input>
			<div className="form-actions">
				<button type="button" className="secondary" disabled={isSaving} onClick={() => setEditMode(false)}>
					Cancel
				</button>
				<button type="submit" disabled={isSaving}>{isSaving ? 'Updating...' : 'Update'}</button>
			</div>
		</form>
	);

	const context: BaseContext = {
		'preventDefaultContextMenuItems': true,
		owner,
		repo,
		number,
		url,
	};
	context['github:copyMenu'] = true;

	const displayTitle = (
		<div className="overview-title">
			<TitleText {...{ titleHTML, number, url, context }} onOpen={openOnGitHub} />
			{canEdit ?
				<button id={EDIT_TITLE_BUTTON_ID} title="Rename" onClick={() => setEditMode(true)} className="icon-button">
					{editIcon}
				</button>
				: null}
			<CopyButton title="Copy Link" ariaLabel="Copy Pull Request Link" copy={copyPrLink} />
			{!isIssue ? <ViewChangesButton /> : null}
		</div>
	);

	const editableTitle = inEditMode ? titleForm : displayTitle;
	return editableTitle;
}

export function ViewChangesButton(): JSX.Element {
	const { viewChanges } = useContext(PullRequestContext);
	const [isBusy, run] = useBusyAction();

	return (
		<button title={isBusy ? 'Opening Changes...' : 'View Changes'} onClick={() => run(viewChanges)} disabled={isBusy} className="icon-button"
			aria-label={isBusy ? 'Opening Pull Request Changes...' : 'View Pull Request Changes'}>
			{isBusy ? loadingIcon : diffMultipleIcon}
		</button>
	);
}

interface ButtonGroupProps {
	isCurrentlyCheckedOut: boolean;
	isIssue: boolean;
	isAgentSessionsWorkspace: boolean;
	doneCheckoutBranch: string;
	owner: string;
	repo: string;
	number: number;
}

function ButtonGroup({ isCurrentlyCheckedOut, isIssue, isAgentSessionsWorkspace, doneCheckoutBranch, owner, repo, number }: ButtonGroupProps): JSX.Element {
	const { refresh } = useContext(PullRequestContext);
	const [isRefreshing, run] = useBusyAction();

	return (
		<div className="button-group">
			{isAgentSessionsWorkspace ? null : <CheckoutButton {...{ isCurrentlyCheckedOut, isIssue, doneCheckoutBranch, owner, repo, number }} />}
			<button title="Refresh with the latest data from GitHub" onClick={() => run(refresh)} disabled={isRefreshing} className="secondary">
				{isRefreshing ? 'Refreshing...' : 'Refresh'}
			</button>
		</div>
	);
}

function CancelCodingAgentButton({ canEdit, codingAgentEvent }: { canEdit: boolean; codingAgentEvent: TimelineEvent | undefined }): JSX.Element | null {
	const { cancelCodingAgent, updatePR, openSessionLog } = useContext(PullRequestContext);
	const [pending, run] = usePendingAction<'cancel' | 'viewSession'>();

	const cancel = () => run('cancel', async () => {
		if (!codingAgentEvent) {
			return;
		}
		const result = await cancelCodingAgent(codingAgentEvent);
		if (result.events.length > 0) {
			updatePR(result);
		}
	});

	const viewSession = (link: SessionLinkInfo) => run('viewSession', () => openSessionLog(link));

	// Extract sessionLink from the coding agent event
	const sessionLink = (codingAgentEvent as CopilotStartedEvent)?.sessionLink;

	if (!codingAgentEvent || copilotEventToStatus(codingAgentEvent) !== CopilotPRStatus.Started) {
		return null;
	}

	const context: CodingAgentContext = {
		'preventDefaultContextMenuItems': true,
		'github:codingAgentMenu': true,
		...sessionLink
	};

	const actions: { label: string; value: string; action: (event: React.MouseEvent<HTMLButtonElement, MouseEvent>) => void }[] = [];

	if (sessionLink) {
		actions.push({
			label: 'View Session',
			value: '',
			action: () => viewSession(sessionLink)
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
		defaultOptionLabel={() => pending ? (
			<>
				<span className='loading-button'>{loadingIcon}</span>
				{pending === 'cancel' ? 'Cancelling Coding Agent...' : 'Opening Session...'}
			</>
		) : actions[0].label}
		defaultOptionValue={() => actions[0].value}
		allOptions={() => {
			return actions;
		}}
		optionsTitle={actions[0].label}
		disabled={!!pending}
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
	canEdit: boolean;
	stack?: PullRequestStack;
}

function Subtitle({ state, stateReason, isDraft, isIssue, author, base, head, codingAgentEvent, canEdit, stack }: SubtitleProps): JSX.Element {
	const { changeBaseBranch } = useContext(PullRequestContext);
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
			{!isIssue ? <StackBadge stack={stack} /> : null}
			<div className="author">
				{<Avatar for={author} substituteIcon={copilotStatusIcon} />}
				<div className="merge-branches">
					<AuthorLink for={author} /> {!isIssue ? (<>
						{getActionText(state)} into{' '}
						{canEdit && state === GithubItemStateEnum.Open ? (
							<button
								title="Change base branch"
								onClick={changeBaseBranch}
								className="secondary change-base"
								aria-label="Change base branch"
							>
								<code className="branch-tag">{base} {editIcon}</code>
							</button>
						) : (
							<code className="branch-tag">{base}</code>
						)}
						{' '}from <code className="branch-tag">{head}</code>
					</>) : null}
				</div>
			</div>
		</div>
	);
}

interface CheckoutButtonProps {
	isCurrentlyCheckedOut: boolean;
	isIssue: boolean;
	doneCheckoutBranch: string;
	owner: string;
	repo: string;
	number: number;
}

type CheckoutAction = 'checkout' | 'exitReviewMode' | 'openChanges';

const CheckoutButton: React.FC<CheckoutButtonProps> = ({ isCurrentlyCheckedOut, isIssue, doneCheckoutBranch, owner, repo, number }) => {
	const { exitReviewMode, checkout, openChanges } = useContext(PullRequestContext);
	const [pending, run] = usePendingAction<CheckoutAction>();

	const onClick = (command: CheckoutAction) => run(command, async () => {
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
	});

	if (isIssue) {
		return null;
	}

	const context: OverviewContext = {
		'preventDefaultContextMenuItems': true,
		'github:checkoutMenu': true,
		owner,
		repo,
		number
	};

	const actions: { label: string; value: string; action: (event: React.MouseEvent<HTMLButtonElement, MouseEvent>) => void }[] = [];

	if (isCurrentlyCheckedOut) {
				actions.push({
			label: `Checkout '${doneCheckoutBranch}'`,
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

	const progress: Record<CheckoutAction, string> = {
		checkout: 'Checking Out...',
		exitReviewMode: `Checking Out '${doneCheckoutBranch}'...`,
		openChanges: 'Opening Changes...',
	};

	return <ContextDropdown
		optionsContext={() => JSON.stringify(context)}
		defaultAction={actions[0].action}
		defaultOptionLabel={() => pending ? (
			<>
				<span className='loading-button'>{loadingIcon}</span>
				{progress[pending]}
			</>
		) : actions[0].label}
		defaultOptionValue={() => actions[0].value}
		allOptions={() => {
			return actions;
		}}
		optionsTitle={actions[0].label}
		disabled={!!pending}
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
