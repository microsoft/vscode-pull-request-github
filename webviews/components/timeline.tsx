/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import React, { useContext, useEffect, useRef, useState } from 'react';
import { CommentView } from './comment';
import { CommitVerificationBadge } from './commitVerification';
import Diff from './diff';
import { addIcon, checkIcon, circleFilledIcon, closeIcon, commentIcon, errorIcon, gitCommitIcon, gitMergeIcon, loadingIcon, tasklistIcon, threeBars } from './icon';
import { nbsp } from './space';
import { Timestamp } from './timestamp';
import { AuthorLink, Avatar } from './user';
import { IComment } from '../../src/common/comment';
import {
	AddedToMergeQueueEvent,
	AutoMergeDisabledEvent,
	AutoMergeEnabledEvent,
	BaseRefChangedEvent,
	ClosedEvent,
	CommentEvent,
	CommitEvent,
	ConvertToDraftEvent,
	CopilotFinishedErrorEvent,
	CopilotFinishedEvent,
	CopilotReviewStartedEvent,
	CopilotStartedEvent,
	CrossReferencedEvent,
	DemilestonedEvent,
	EventType,
	ForcePushedCommit,
	HeadRefDeleteEvent,
	HeadRefForcePushedEvent,
	HeadRefRestoredEvent,
	MergedEvent,
	MilestonedEvent,
	ReadyForReviewEvent,
	RemovedFromMergeQueueEvent,
	RenamedTitleEvent,
	ReopenedEvent,
	ReviewDismissedEvent,
	ReviewEvent,
	TimelineEvent,
} from '../../src/common/timelineEvent';
import { gitHubLabelColor, groupBy, UnreachableCaseError } from '../../src/common/utils';
import { IAccount, IActor, isITeam, ITeam, reviewerId } from '../../src/github/interface';
import { DisplayLabel, ReviewType } from '../../src/github/views';
import PullRequestContext from '../common/context';

const CONSOLIDATION_WINDOW_MS = 1000 * 60 * 10;

interface ConsolidatedAssignUnassignEvent {
	id: number;
	event: EventType.Assigned | EventType.Unassigned;
	assignees: IAccount[];
	unassignees: IAccount[];
	actor: IActor;
	createdAt: string;
}

interface ConsolidatedLabelEvent {
	id: string;
	event: EventType.Labeled | EventType.Unlabeled;
	added: DisplayLabel[];
	removed: DisplayLabel[];
	actor: IActor;
	createdAt: string;
}

interface ConsolidatedReviewRequestEvent {
	id: string;
	event: EventType.ReviewRequested | EventType.ReviewRequestRemoved;
	requested: (IAccount | ITeam)[];
	removed: (IAccount | ITeam)[];
	actor: IActor;
	createdAt: string;
}

type ConsolidatedEventTypes = EventType.Assigned | EventType.Unassigned | EventType.Labeled | EventType.Unlabeled | EventType.ReviewRequested | EventType.ReviewRequestRemoved;

type DisplayedTimelineEvent =
	| Exclude<TimelineEvent, { event: ConsolidatedEventTypes }>
	| ConsolidatedAssignUnassignEvent
	| ConsolidatedLabelEvent
	| ConsolidatedReviewRequestEvent;

function canConsolidate(previous: { actor: IActor, createdAt: string }, next: { actor: IActor, createdAt: string }): boolean {
	return (previous.actor.login === next.actor.login)
		&& (new Date(previous.createdAt).getTime() + CONSOLIDATION_WINDOW_MS > new Date(next.createdAt).getTime());
}

function addUnique<T>(items: T[], newItems: T[], key: (item: T) => string): T[] {
	const keys = new Set(items.map(key));
	return [...items, ...newItems.filter(item => !keys.has(key(item)))];
}

/**
 * Combines consecutive assignment, label, and review request changes made by the same actor within a short time window into a single event.
 */
function consolidateEvents(events: TimelineEvent[]): DisplayedTimelineEvent[] {
	const consolidated: DisplayedTimelineEvent[] = [];
	for (const event of events) {
		const last = consolidated.length > 0 ? consolidated[consolidated.length - 1] : undefined;
		switch (event.event) {
			case EventType.Assigned:
			case EventType.Unassigned: {
				const assignees = event.event === EventType.Assigned ? event.assignees : [];
				const unassignees = event.event === EventType.Unassigned ? event.unassignees : [];
				if (last && (last.event === EventType.Assigned || last.event === EventType.Unassigned) && canConsolidate(last, event)) {
					consolidated[consolidated.length - 1] = {
						...last,
						assignees: addUnique(last.assignees, assignees, a => a.id),
						unassignees: addUnique(last.unassignees, unassignees, a => a.id),
					};
				} else {
					consolidated.push({ id: event.id, event: event.event, actor: event.actor, createdAt: event.createdAt, assignees, unassignees });
				}
				break;
			}
			case EventType.Labeled:
			case EventType.Unlabeled: {
				const added = event.event === EventType.Labeled ? [event.label] : [];
				const removed = event.event === EventType.Unlabeled ? [event.label] : [];
				if (last && (last.event === EventType.Labeled || last.event === EventType.Unlabeled) && canConsolidate(last, event)) {
					consolidated[consolidated.length - 1] = {
						...last,
						added: addUnique(last.added, added, l => l.name),
						removed: addUnique(last.removed, removed, l => l.name),
					};
				} else {
					consolidated.push({ id: event.id, event: event.event, actor: event.actor, createdAt: event.createdAt, added, removed });
				}
				break;
			}
			case EventType.ReviewRequested:
			case EventType.ReviewRequestRemoved: {
				const requested = event.event === EventType.ReviewRequested ? [event.reviewer] : [];
				const removed = event.event === EventType.ReviewRequestRemoved ? [event.reviewer] : [];
				if (last && (last.event === EventType.ReviewRequested || last.event === EventType.ReviewRequestRemoved) && canConsolidate(last, event)) {
					consolidated[consolidated.length - 1] = {
						...last,
						requested: addUnique(last.requested, requested, reviewerId),
						removed: addUnique(last.removed, removed, reviewerId),
					};
				} else {
					consolidated.push({ id: event.id, event: event.event, actor: event.actor, createdAt: event.createdAt, requested, removed });
				}
				break;
			}
			default:
				consolidated.push(event);
		}
	}
	return consolidated;
}

export const Timeline = ({ events, isIssue }: { events: TimelineEvent[], isIssue: boolean }) => {
	const consolidatedEvents = consolidateEvents(events);

	return <>{consolidatedEvents.map(event => {
		switch (event.event) {
			case EventType.Committed:
				return <CommitEventView key={`commit${event.id}`} {...event} />;
			case EventType.Reviewed:
				return <ReviewEventView key={`review${event.id}`} {...event} />;
			case EventType.Commented:
				return <CommentEventView key={`comment${event.id}`} {...event} />;
			case EventType.Merged:
				return <MergedEventView key={`merged${event.id}`} {...event} />;
			case EventType.Assigned:
				return <AssignUnassignEventView key={`assign${event.id}`} event={event} />;
			case EventType.Unassigned:
				return <AssignUnassignEventView key={`unassign${event.id}`} event={event} />;
			case EventType.HeadRefDeleted:
				return <HeadDeleteEventView key={`head${event.id}`} {...event} />;
			case EventType.CrossReferenced:
				return <CrossReferencedEventView key={`cross${event.id}`} {...event} />;
			case EventType.Closed:
				return <ClosedEventView key={`closed${event.id}`} event={event} isIssue={isIssue} />;
			case EventType.Reopened:
				return <ReopenedEventView key={`reopened${event.id}`} event={event} isIssue={isIssue} />;
			case EventType.BaseRefChanged:
				return <BaseRefChangedEventView key={`baseref${event.id}`} event={event} />;
			case EventType.NewCommitsSinceReview:
				return <NewCommitsSinceReviewEventView key={`newCommits${event.id}`} />;
			case EventType.CopilotStarted:
				return <CopilotStartedEventView key={`copilotStarted${event.id}`} {...event} />;
			case EventType.CopilotFinished:
				return <CopilotFinishedEventView key={`copilotFinished${event.id}`} {...event} />;
			case EventType.CopilotFinishedError:
				return <CopilotFinishedErrorEventView key={`copilotFinishedError${event.id}`} {...event} />;
			case EventType.CopilotReviewStarted:
				return <CopilotReviewStartedEventView key={`copilotReviewStarted${event.id}`} {...event} />;
			case EventType.Labeled:
			case EventType.Unlabeled:
				return <LabelEventView key={`label${event.id}`} event={event} />;
			case EventType.Milestoned:
			case EventType.Demilestoned:
				return <MilestoneEventView key={`milestone${event.id}`} event={event} />;
			case EventType.RenamedTitle:
				return <RenamedTitleEventView key={`renamed${event.id}`} event={event} />;
			case EventType.ReviewRequested:
			case EventType.ReviewRequestRemoved:
				return <ReviewRequestEventView key={`reviewRequest${event.id}`} event={event} />;
			case EventType.ReadyForReview:
			case EventType.ConvertToDraft:
				return <DraftStateEventView key={`draftState${event.id}`} event={event} />;
			case EventType.HeadRefForcePushed:
				return <HeadRefForcePushedEventView key={`forcePushed${event.id}`} event={event} />;
			case EventType.HeadRefRestored:
				return <HeadRefRestoredEventView key={`headRestored${event.id}`} event={event} />;
			case EventType.ReviewDismissed:
				return <ReviewDismissedEventView key={`reviewDismissed${event.id}`} event={event} />;
			case EventType.AutoMergeEnabled:
			case EventType.AutoMergeDisabled:
				return <AutoMergeEventView key={`autoMerge${event.id}`} event={event} />;
			case EventType.AddedToMergeQueue:
			case EventType.RemovedFromMergeQueue:
				return <MergeQueueEventView key={`mergeQueue${event.id}`} event={event} />;
			default:
				throw new UnreachableCaseError(event);
		}
	})}</>;
};

export default Timeline;


function CommitStateIcon({ status }: { status: 'EXPECTED' | 'ERROR' | 'FAILURE' | 'PENDING' | 'SUCCESS' | undefined; }) {
	switch (status) {
		case 'PENDING':
			return circleFilledIcon;
		case 'SUCCESS':
			return checkIcon;
		case 'FAILURE':
		case 'ERROR':
			return closeIcon;
	}
	return null;
}

const CommitEventView = (event: CommitEvent) => {
	const context = useContext(PullRequestContext);
	const [clickedElement, setClickedElement] = useState<'title' | 'sha' | undefined>(undefined);

	const handleCommitClick = (e: React.MouseEvent, elementType: 'title' | 'sha') => {
		e.preventDefault();
		setClickedElement(elementType);
		context.openCommitChanges(event.sha).finally(() => {
			setClickedElement(undefined);
		});
	};

	const isLoading = context.pr?.loadingCommit === event.sha;

	return (
		<div className="comment-container commit">
			<div className="commit-message">
				{gitCommitIcon}
				{nbsp}
				<div className="avatar-container">
					<Avatar for={event.author} />
				</div>
				<div className="message-container">
					<a
						className="message"
						onClick={(e) => handleCommitClick(e, 'title')}
						title={event.htmlUrl}
					>
						{event.message.substr(0, event.message.indexOf('\n') > -1 ? event.message.indexOf('\n') : event.message.length)}
					</a>
					{isLoading && clickedElement === 'title' && <span className="commit-spinner-inline">{loadingIcon}</span>}
				</div>
			</div>
			<div className="timeline-detail">
				<div className='status-section'>
					<CommitStateIcon status={event.status} />
				</div>
				<CommitVerificationBadge verification={event.verification} committedDate={event.committedDate} />
				<a
					className="sha"
					onClick={(e) => handleCommitClick(e, 'sha')}
					title={event.htmlUrl}
				>
					{isLoading && clickedElement === 'sha' && <span className="commit-spinner-before">{loadingIcon}</span>}
					{event.sha.slice(0, 7)}
				</a>
				<Timestamp date={event.committedDate} />
			</div>
		</div>
	);
};

const NewCommitsSinceReviewEventView = () => {
	const { gotoChangesSinceReview, pr } = useContext(PullRequestContext);
	if (!pr.isCurrentlyCheckedOut) {
		return null;
	}

	const [busy, setBusy] = useState(false);
	const viewChanges = async () => {
		setBusy(true);
		await gotoChangesSinceReview();
		setBusy(false);
	};

	return (
		<div className="comment-container commit">
			<div className="commit-message">
				{addIcon}
				{nbsp}
				<span style={{ fontWeight: 'bold' }}>New changes since your last Review</span>
			</div>
			<button
				aria-live="polite"
				title="View the changes since your last review"
				onClick={viewChanges}
				disabled={busy}
			>
				View Changes
			</button>
		</div>
	);
};

const positionKey = (comment: IComment) =>
	comment.position !== null ? `pos:${comment.position}` : `ori:${comment.originalPosition}`;

// Group review comments so that each rendered CommentThread contains exactly
// one review thread's comments. Prefer grouping by the thread's GraphQL id
// (set on each IComment when parsed from a review thread) so that resolve /
// unresolve actions target the right thread. Fall back to path+position for
// comments without a threadId (e.g. pending review comments not yet posted).
const groupCommentsByThread = (comments: IComment[]) =>
	groupBy(comments, comment =>
		comment.threadId
			? `thread:${comment.threadId}`
			: comment.path + ':' + positionKey(comment));

const ReviewEventView = (event: ReviewEvent) => {
	const comments = groupCommentsByThread(event.comments);
	const reviewIsPending = event.state === 'PENDING';
	return (
		<CommentView comment={event} allowEmpty={true}>
			{/* Don't show the empty comment body unless a comment has been written. Shows diffs and suggested changes. */}
			{event.comments.length ? (
				<div className="comment-body review-comment-body">
					{Object.entries(comments).map(([key, thread]) => {
						return <CommentThread key={key} thread={thread} event={event} />;
					})}
				</div>
			) : null}

			{reviewIsPending ? <AddReviewSummaryComment /> : null}
		</CommentView>
	);
};

function CommentThread({ thread, event }: { thread: IComment[]; event: ReviewEvent }) {
	const comment = thread[0];
	const [revealed, setRevealed] = useState(!comment.isResolved);
	const [resolved, setResolved] = useState(!!comment.isResolved);
	const { openDiff, toggleResolveComment } = useContext(PullRequestContext);

	useEffect(() => {
		setResolved(!!comment.isResolved);
		setRevealed(!comment.isResolved);
	}, [comment.isResolved]);
	// Look up this group's own review thread info. A single ReviewEvent can
	// have comments on multiple threads, so resolve actions must target the
	// thread that owns this group's comments - looked up by `comment.threadId`.
	const reviewThread = comment.threadId ? event.reviewThreads?.[comment.threadId] : undefined;
	const resolvePermission =
		reviewThread &&
		((reviewThread.canResolve && !reviewThread.isResolved) ||
			(reviewThread.canUnresolve && reviewThread.isResolved));

	const toggleResolve = () => {
		if (reviewThread) {
			const newResolved = !resolved;
			setRevealed(!newResolved);
			setResolved(newResolved);
			toggleResolveComment(reviewThread.threadId, thread, newResolved);
		}
	};

	return (
		<div key={event.id} className="diff-container">
			<div className="resolved-container">
				<div>
					{comment.position === null ? (
						<span>
							<span>{comment.path}</span>
							<span className="outdatedLabel">Outdated</span>
						</span>
					) : (
						<a className="diffPath" onClick={() => openDiff(comment)}>
							{comment.path}
						</a>
					)}
					{!resolved && !revealed ? <span className="unresolvedLabel">Unresolved</span> : null}
				</div>
				<button className="secondary" onClick={() => setRevealed(!revealed)}>
					{revealed ? 'Hide' : 'Show'}
				</button>
			</div>
			{revealed ? (
				<div>
					<Diff hunks={comment.diffHunks ?? []} />
					{thread.map(c => (
						<CommentView key={c.id} comment={c} />
					))}
					{resolvePermission ? (
						<div className="resolve-comment-row">
							<button className="secondary comment-resolve" onClick={() => toggleResolve()}>
								{resolved ? 'Unresolve Conversation' : 'Resolve Conversation'}
							</button>
						</div>
					) : null}
				</div>
			) : null}
		</div>
	);
}

function AddReviewSummaryComment() {
	const { requestChanges, approve, submit, deleteReview, updatePR, pr } = useContext(PullRequestContext);
	const isAuthor = pr?.isAuthor;
	const comment = useRef<HTMLTextAreaElement>();
	const [isBusy, setBusy] = useState(false);
	const commentText = pr.pendingReviewSummaryText ?? '';
	const addAttestation = !!pr.pendingAttestation;

	const showAttestationCheckbox = !isAuthor && !!pr?.attestationCommitsEnabled && !!pr?.isCurrentlyCheckedOut;

	async function submitAction(event: React.MouseEvent | React.KeyboardEvent, action: ReviewType): Promise<void> {
		event.preventDefault();
		const value = commentText;
		setBusy(true);
		switch (action) {
			case ReviewType.RequestChanges:
				await requestChanges(value, addAttestation);
				break;
			case ReviewType.Approve:
				await approve(value, addAttestation);
				break;
			default:
				await submit(value, addAttestation);
		}
		setBusy(false);
	}

	async function cancelReview(event: React.MouseEvent): Promise<void> {
		event.preventDefault();
		setBusy(true);
		await deleteReview();
		setBusy(false);
	}

	const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
			submitAction(event, ReviewType.Comment);
		}
	};

	const onTextareaChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
		updatePR({ pendingReviewSummaryText: event.target.value });
	};

	// Disable buttons when summary comment is empty AND there are no review comments
	// Note: Approve button is allowed even with empty content and no pending review
	const shouldDisableButtons = !commentText.trim() && !pr.hasReviewDraft;

	return (
		<form>
			<textarea
				id='pending-review'
				ref={comment}
				placeholder="Leave a review summary comment"
				onKeyDown={onKeyDown}
				onChange={onTextareaChange}
				value={commentText}
			></textarea>
			<div className="form-actions">
				<button
					id="cancel-review"
					className='secondary'
					disabled={isBusy || pr?.busy}
					onClick={cancelReview}
				>
					Cancel Review
				</button>
				{showAttestationCheckbox ? (
					<div className="attestation-checkbox-wrapper checkbox-wrapper" title="Add a signed attestation commit to the head of the pull request branch when submitting this review.">
						<input
							id="attestation-checkbox-summary"
							type="checkbox"
							name="add-attestation"
							checked={addAttestation}
							disabled={isBusy || pr?.busy}
							onChange={(e) => updatePR({ pendingAttestation: e.currentTarget.checked })}
						/>
						<label htmlFor="attestation-checkbox-summary" className="attestation-checkbox-label">Add attestation</label>
					</div>
				) : null}
				{isAuthor ? null : (
					<button
						id="request-changes"
						className='secondary'
						disabled={isBusy || pr.busy || shouldDisableButtons}
						onClick={(event) => submitAction(event, ReviewType.RequestChanges)}
					>
						Request Changes
					</button>
				)}
				{isAuthor ? null : (
					<button
						id="approve" className='secondary'
						disabled={isBusy || pr.busy}
						onClick={(event) => submitAction(event, ReviewType.Approve)}
					>
						Approve
					</button>
				)}
				<button
					disabled={isBusy || pr.busy || shouldDisableButtons}
					onClick={(event) => submitAction(event, ReviewType.Comment)}
				>Submit Review</button>
			</div>
		</form>
	);
}

const CommentEventView = (event: CommentEvent) => <CommentView headerInEditMode comment={event} />;

const MergedEventView = (event: MergedEvent) => {
	const { revert, pr } = useContext(PullRequestContext);

	return (
		<div className="comment-container commit">
			<div className="commit-message">
				{gitMergeIcon}
				{nbsp}
				<div className="avatar-container">
					<Avatar for={event.user} />
				</div>
				<AuthorLink for={event.user} />
				<div className="message">
					merged commit{nbsp}
					<a className="sha" href={event.commitUrl} title={event.commitUrl}>
						{event.sha.substr(0, 7)}
					</a>
					{nbsp}
					into {event.mergeRef}
					{nbsp}
				</div>
			</div>
			{pr.revertable ?
				<div className="timeline-detail">
					<button className='secondary' disabled={pr.busy} onClick={revert}>Revert</button>
				</div> : null}
			<Timestamp href={event.url} date={event.createdAt} />
		</div>
	);
};

const HeadDeleteEventView = (event: HeadRefDeleteEvent) => (
	<div className="comment-container commit">
		<div className="commit-message">
			<div className="avatar-container">
				<Avatar for={event.actor} />
			</div>
			<AuthorLink for={event.actor} />
			<div className="message">
				deleted the {event.headRef} branch{nbsp}
			</div>
		</div>
		<Timestamp date={event.createdAt} />
	</div>
);

const CrossReferencedEventView = (event: CrossReferencedEvent) => {
	const { source } = event;
	return (
		<div className="comment-container commit">
			<div className="commit-message">
				<div className="avatar-container">
					<Avatar for={event.actor} />
				</div>
				<AuthorLink for={event.actor} />
				<div className="message">
					linked <a href={source.extensionUrl}>#{source.number}</a> {source.title}
					{nbsp}
					{event.willCloseTarget ? 'which will close this issue' : ''}
				</div>
			</div>
			<Timestamp date={event.createdAt} />
		</div>
	);
};

function joinWithAnd(arr: JSX.Element[]): JSX.Element {
	if (arr.length === 0) return <></>;
	if (arr.length === 1) return arr[0];
	if (arr.length === 2) return <>{arr[0]} and {arr[1]}</>;
	return <>{arr.slice(0, -1).map((item, index) => <React.Fragment key={index}>{item}, </React.Fragment>)} and {arr[arr.length - 1]}</>;
}

const AssignUnassignEventView = ({ event }: { event: ConsolidatedAssignUnassignEvent }) => {
	const { actor, assignees, unassignees } = event;
	const joinedAssignees = joinWithAnd(assignees.map(a => <AuthorLink key={`${a.id}a`} for={a} />));
	const joinedUnassignees = joinWithAnd(unassignees.map(a => <AuthorLink key={`${a.id}u`} for={a} />));

	// Check if actor is assigning/unassigning themselves
	const isSelfAssign = assignees.length === 1 && assignees[0].login === actor.login;
	const isSelfUnassign = unassignees.length === 1 && unassignees[0].login === actor.login;

	let message: JSX.Element;
	if (assignees.length > 0 && unassignees.length > 0) {
		// Handle mixed case with potential self-assignment
		const assignMessage = isSelfAssign ? <>self-assigned this</> : <>assigned {joinedAssignees}</>;
		const unassignMessage = isSelfUnassign ? <>removed their assignment</> : <>unassigned {joinedUnassignees}</>;
		message = <>{assignMessage} and {unassignMessage}</>;
	} else if (assignees.length > 0) {
		message = isSelfAssign ? <>self-assigned this</> : <>assigned {joinedAssignees}</>;
	} else {
		message = isSelfUnassign ? <>removed their assignment</> : <>unassigned {joinedUnassignees}</>;
	}

	return (
		<div className="comment-container commit">
			<div className="commit-message">
				<div className="avatar-container">
					<Avatar for={actor} />
				</div>
				<AuthorLink for={actor} />
				<div className="message">
					{message}
				</div>
			</div>
			<Timestamp date={event.createdAt} />
		</div>
	);
};

const ClosedEventView = ({ event, isIssue }: { event: ClosedEvent, isIssue: boolean }) => {
	const { actor, createdAt } = event;
	return (
		<div className="comment-container commit">
			<div className="commit-message">
				<div className="avatar-container">
					<Avatar for={actor} />
				</div>
				<AuthorLink for={actor} />
				<div className="message">{isIssue ? 'closed this issue' : 'closed this pull request'}</div>
			</div>
			<Timestamp date={createdAt} />
		</div>
	);
};

const ReopenedEventView = ({ event, isIssue }: { event: ReopenedEvent, isIssue: boolean }) => {
	const { actor, createdAt } = event;
	return (
		<div className="comment-container commit">
			<div className="commit-message">
				<div className="avatar-container">
					<Avatar for={actor} />
				</div>
				<AuthorLink for={actor} />
				<div className="message">{isIssue ? 'reopened this issue' : 'reopened this pull request'}</div>
			</div>
			<Timestamp date={createdAt} />
		</div>
	);
};

const BaseRefChangedEventView = ({ event }: { event: BaseRefChangedEvent }) => {
	const { actor, createdAt, currentRefName, previousRefName } = event;
	return (
		<div className="comment-container commit">
			<div className="commit-message">
				<div className="avatar-container">
					<Avatar for={actor} />
				</div>
				<AuthorLink for={actor} />
				<div className="message">
					changed the base branch from <code className="branch-tag">{previousRefName}</code> to <code className="branch-tag">{currentRefName}</code>
				</div>
			</div>
			<Timestamp date={createdAt} />
		</div>
	);
};

const CopilotStartedEventView = (event: CopilotStartedEvent) => {
	const { createdAt, onBehalfOf, sessionLink } = event;
	const { openSessionLog } = useContext(PullRequestContext);

	const handleSessionLogClick = (e: React.MouseEvent) => {
		if (sessionLink) {
			sessionLink.openToTheSide = e.ctrlKey || e.metaKey;
			openSessionLog(sessionLink);
		}
	};

	return (
		<div className="comment-container commit">
			<div className="commit-message">
				{threeBars}
				{nbsp}
				<div className="message">Copilot started work on behalf of <AuthorLink for={onBehalfOf} /></div>
			</div>
			{sessionLink ? (
				<div className="timeline-detail">
					<a onClick={handleSessionLogClick}><button className='secondary' title="View session log (Ctrl/Cmd+Click to open in second editor group)">View session</button></a>
				</div>)
				: null}
			<Timestamp date={createdAt} />
		</div>
	);
};

const CopilotFinishedEventView = (event: CopilotFinishedEvent) => {
	const { createdAt, onBehalfOf } = event;
	return (
		<div className="comment-container commit">
			<div className="commit-message">
				{tasklistIcon}
				{nbsp}
				<div className="message">Copilot finished work on behalf of <AuthorLink for={onBehalfOf} /></div>
			</div>
			<Timestamp date={createdAt} />
		</div>
	);
};

const CopilotFinishedErrorEventView = (event: CopilotFinishedErrorEvent) => {
	const { createdAt, onBehalfOf } = event;
	const { openSessionLog } = useContext(PullRequestContext);

	const handleSessionLogClick = (e: React.MouseEvent) => {
		event.sessionLink.openToTheSide = e.ctrlKey || e.metaKey;
		openSessionLog(event.sessionLink);
	};

	return (
		<div className="comment-container commit">
			<div className='timeline-with-detail'>
				<div className='commit-message'>
					{errorIcon}
					{nbsp}
					<div className="message">Copilot stopped work on behalf of <AuthorLink for={onBehalfOf} /> due to an error</div>
				</div>
				<div className="commit-message-detail">
					<a onClick={handleSessionLogClick} title="View session log (Ctrl/Cmd+Click to open in second editor group)">Copilot has encountered an error. See logs for additional details.</a>
				</div>
			</div>
			<Timestamp date={createdAt} />
		</div>
	);
};

const CopilotReviewStartedEventView = (event: CopilotReviewStartedEvent) => {
	const { createdAt } = event;
	return (
		<div className="comment-container commit">
			<div className="commit-message">
				{commentIcon}
				{nbsp}
				<div className="message">Copilot started reviewing</div>
			</div>
			<Timestamp date={createdAt} />
		</div>
	);
};

const ActorEventView = ({ actor, createdAt, children, detail, wrap = false }: { actor: IActor; createdAt: string; children: React.ReactNode; detail?: string; wrap?: boolean }) => {
	const summary = (
		<div className="commit-message">
			<div className="avatar-container">
				<Avatar for={actor} />
			</div>
			<AuthorLink for={actor} />
			<div className={wrap ? 'message wrap' : 'message'}>{children}</div>
		</div>
	);
	return (
		<div className="comment-container commit">
			{detail ? (
				<div className="timeline-with-detail">
					{summary}
					<div className="commit-message-detail timeline-event-detail">{detail}</div>
				</div>
			) : summary}
			<Timestamp date={createdAt} />
		</div>
	);
};

const TimelineLabel = ({ label }: { label: DisplayLabel }) => {
	const { pr } = useContext(PullRequestContext);
	const labelColor = gitHubLabelColor(label.color, !!pr?.isDarkTheme, false);
	return (
		<span
			className="label timeline-label"
			style={{
				backgroundColor: labelColor.backgroundColor,
				color: labelColor.textColor,
				borderColor: labelColor.borderColor,
			}}
		>
			{label.displayName}
		</span>
	);
};

function joinLabels(labels: DisplayLabel[]): JSX.Element {
	return <>{labels.map((label, index) => <React.Fragment key={label.name}>{index > 0 ? ' ' : null}<TimelineLabel label={label} /></React.Fragment>)}</>;
}

const LabelEventView = ({ event }: { event: ConsolidatedLabelEvent }) => {
	const { added, removed } = event;
	const noun = (added.length + removed.length) > 1 ? 'labels' : 'label';
	let message: JSX.Element;
	if (added.length > 0 && removed.length > 0) {
		message = <>added {joinLabels(added)} and removed {joinLabels(removed)} {noun}</>;
	} else if (added.length > 0) {
		message = <>added {added.length === 1 ? 'the ' : null}{joinLabels(added)} {noun}</>;
	} else {
		message = <>removed {removed.length === 1 ? 'the ' : null}{joinLabels(removed)} {noun}</>;
	}
	return <ActorEventView actor={event.actor} createdAt={event.createdAt} wrap>{message}</ActorEventView>;
};

const MilestoneEventView = ({ event }: { event: MilestonedEvent | DemilestonedEvent }) => (
	<ActorEventView actor={event.actor} createdAt={event.createdAt}>
		{event.event === EventType.Milestoned ? 'added this to the ' : 'removed this from the '}
		<strong>{event.milestoneTitle}</strong> milestone
	</ActorEventView>
);

const RenamedTitleEventView = ({ event }: { event: RenamedTitleEvent }) => (
	<ActorEventView actor={event.actor} createdAt={event.createdAt} wrap>
		changed the title <del className="previous-title">{event.previousTitle}</del> <ins className="current-title">{event.currentTitle}</ins>
	</ActorEventView>
);

function joinReviewers(reviewers: (IAccount | ITeam)[]): JSX.Element {
	return joinWithAnd(reviewers.map(reviewer => <AuthorLink key={reviewerId(reviewer)} for={reviewer} />));
}

const ReviewRequestEventView = ({ event }: { event: ConsolidatedReviewRequestEvent }) => {
	const { actor, requested, removed } = event;
	let requestedMessage: JSX.Element | undefined;
	if (requested.length === 1 && !isITeam(requested[0]) && requested[0].login === actor.login) {
		requestedMessage = <>self-requested a review</>;
	} else if (requested.length === 1) {
		requestedMessage = <>requested a review from {joinReviewers(requested)}</>;
	} else if (requested.length > 1) {
		requestedMessage = <>requested reviews from {joinReviewers(requested)}</>;
	}
	const removedMessage = removed.length > 0 ? <>removed the request for review from {joinReviewers(removed)}</> : undefined;
	const message = (requestedMessage && removedMessage) ? <>{requestedMessage} and {removedMessage}</> : (requestedMessage ?? removedMessage);
	return <ActorEventView actor={actor} createdAt={event.createdAt} wrap>{message}</ActorEventView>;
};

const DraftStateEventView = ({ event }: { event: ReadyForReviewEvent | ConvertToDraftEvent }) => (
	<ActorEventView actor={event.actor} createdAt={event.createdAt}>
		{event.event === EventType.ReadyForReview ? 'marked this pull request as ready for review' : 'marked this pull request as draft'}
	</ActorEventView>
);

const ForcePushedCommitLink = ({ commit }: { commit: ForcePushedCommit }) => (
	<a className="sha" href={commit.url} title={commit.url}>{commit.sha.slice(0, 7)}</a>
);

const HeadRefForcePushedEventView = ({ event }: { event: HeadRefForcePushedEvent }) => {
	const { beforeCommit, afterCommit } = event;
	return (
		<ActorEventView actor={event.actor} createdAt={event.createdAt}>
			force-pushed the <code className="branch-tag">{event.headRef}</code> branch
			{beforeCommit ? <> from <ForcePushedCommitLink commit={beforeCommit} /></> : null}
			{afterCommit ? <> to <ForcePushedCommitLink commit={afterCommit} /></> : null}
		</ActorEventView>
	);
};

const HeadRefRestoredEventView = ({ event }: { event: HeadRefRestoredEvent }) => (
	<ActorEventView actor={event.actor} createdAt={event.createdAt}>
		restored the <code className="branch-tag">{event.headRef}</code> branch
	</ActorEventView>
);

const ReviewDismissedEventView = ({ event }: { event: ReviewDismissedEvent }) => {
	const { reviewAuthor } = event;
	return (
		<ActorEventView actor={event.actor} createdAt={event.createdAt} detail={event.dismissalMessage}>
			{reviewAuthor ? <>dismissed <AuthorLink for={reviewAuthor} />{'\'s review'}</> : 'dismissed a review'}
		</ActorEventView>
	);
};

const AutoMergeEventView = ({ event }: { event: AutoMergeEnabledEvent | AutoMergeDisabledEvent }) => (
	event.event === EventType.AutoMergeEnabled
		? <ActorEventView actor={event.actor} createdAt={event.createdAt}>
			enabled auto-merge{event.mergeMethod ? ` (${event.mergeMethod})` : null}
		</ActorEventView>
		: <ActorEventView actor={event.actor} createdAt={event.createdAt} detail={event.reason}>
			disabled auto-merge
		</ActorEventView>
);

const MergeQueueEventView = ({ event }: { event: AddedToMergeQueueEvent | RemovedFromMergeQueueEvent }) => (
	event.event === EventType.AddedToMergeQueue
		? <ActorEventView actor={event.actor} createdAt={event.createdAt}>
			added this pull request to the merge queue
		</ActorEventView>
		: <ActorEventView actor={event.actor} createdAt={event.createdAt} detail={event.reason}>
			removed this pull request from the merge queue
		</ActorEventView>
);