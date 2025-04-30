/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import React, { useContext, useRef, useState } from 'react';
import { IComment } from '../../src/common/comment';
import {
	AssignEvent,
	ClosedEvent,
	CommentEvent,
	CommitEvent,
	CrossReferencedEvent,
	EventType,
	HeadRefDeleteEvent,
	MergedEvent,
	ReopenedEvent,
	ReviewEvent,
	TimelineEvent,
} from '../../src/common/timelineEvent';
import { groupBy, UnreachableCaseError } from '../../src/common/utils';
import { ReviewType } from '../../src/github/views';
import PullRequestContext from '../common/context';
import { CommentView } from './comment';
import Diff from './diff';
import { commitIcon, mergeIcon, plusIcon } from './icon';
import { nbsp } from './space';
import { Timestamp } from './timestamp';
import { AuthorLink, Avatar } from './user';

export const Timeline = ({ events, isIssue }: { events: TimelineEvent[], isIssue: boolean }) => {
	const consolidatedEvents: TimelineEvent[] = [];
	for (let i = 0; i < events.length; i++) {
		if ((i > 0) && (events[i].event === EventType.Assigned) && (consolidatedEvents[consolidatedEvents.length - 1].event === EventType.Assigned)) {
			const lastEvent = consolidatedEvents[consolidatedEvents.length - 1] as AssignEvent;
			const newEvent = events[i] as AssignEvent;
			if (new Date(lastEvent.createdAt).getTime() + (1000 * 60 * 10) > new Date(newEvent.createdAt).getTime()) { // within 10 minutes
				if (lastEvent.assignees.every(a => a.id !== newEvent.assignees[0].id)) {
					lastEvent.assignees = [...lastEvent.assignees, ...newEvent.assignees];
				}
				lastEvent.createdAt = newEvent.createdAt;
			} else {
				consolidatedEvents.push(newEvent);
			}
		} else {
			consolidatedEvents.push(events[i]);
		}
	}

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
				return <AssignEventView key={`assign${event.id}`} event={event} isIssue={isIssue} />;
			case EventType.HeadRefDeleted:
				return <HeadDeleteEventView key={`head${event.id}`} {...event} />;
			case EventType.CrossReferenced:
				return <CrossReferencedEventView key={`cross${event.id}`} {...event} />;
			case EventType.Closed:
				return <ClosedEventView key={`closed${event.id}`} event={event} isIssue={isIssue} />;
			case EventType.Reopened:
				return <ReopenedEventView key={`reopened${event.id}`} event={event} isIssue={isIssue} />;
			case EventType.NewCommitsSinceReview:
				return <NewCommitsSinceReviewEventView key={`newCommits${event.id}`} />;
			default:
				throw new UnreachableCaseError(event);
		}
	})}</>;
};

export default Timeline;

const CommitEventView = (event: CommitEvent) => (
	<div className="comment-container commit">
		<div className="commit-message">
			{commitIcon}
			{nbsp}
			<div className="avatar-container">
				<Avatar for={event.author} />
			</div>
			<div className="message-container">
				<a className="message" href={event.htmlUrl} title={event.htmlUrl}>
					{event.message.substr(0, event.message.indexOf('\n') > -1 ? event.message.indexOf('\n') : event.message.length)}
				</a>
			</div>
		</div>
		<div className="timeline-detail">
			<a className="sha" href={event.htmlUrl} title={event.htmlUrl}>
				{event.sha.slice(0, 7)}
			</a>
			<Timestamp date={event.authoredDate} />
		</div>
	</div>
);

const NewCommitsSinceReviewEventView = () => {
	const { gotoChangesSinceReview } = useContext(PullRequestContext);
	return (
		<div className="comment-container commit">
			<div className="commit-message">
				{plusIcon}
				{nbsp}
				<span style={{ fontWeight: 'bold' }}>New changes since your last Review</span>
			</div>
			<button
				aria-live="polite"
				title="View the changes since your last review"
				onClick={() => gotoChangesSinceReview()}
			>
				View Changes
			</button>
		</div>
	);
};

const positionKey = (comment: IComment) =>
	comment.position !== null ? `pos:${comment.position}` : `ori:${comment.originalPosition}`;

const groupCommentsByPath = (comments: IComment[]) =>
	groupBy(comments, comment => comment.path + ':' + positionKey(comment));

const ReviewEventView = (event: ReviewEvent) => {
	const comments = groupCommentsByPath(event.comments);
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
	const resolvePermission =
		event.reviewThread &&
		((event.reviewThread.canResolve && !event.reviewThread.isResolved) ||
			(event.reviewThread.canUnresolve && event.reviewThread.isResolved));

	const toggleResolve = () => {
		if (event.reviewThread) {
			const newResolved = !resolved;
			setRevealed(!newResolved);
			setResolved(newResolved);
			toggleResolveComment(event.reviewThread.threadId, thread, newResolved);
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
	const { requestChanges, approve, submit, pr } = useContext(PullRequestContext);
	const { isAuthor } = pr;
	const comment = useRef<HTMLTextAreaElement>();
	const [isBusy, setBusy] = useState(false);

	async function submitAction(event: React.MouseEvent, action: ReviewType): Promise<void> {
		event.preventDefault();
		const { value } = comment.current!;
		setBusy(true);
		switch (action) {
			case ReviewType.RequestChanges:
				await requestChanges(value);
				break;
			case ReviewType.Approve:
				await approve(value);
				break;
			default:
				await submit(value);
		}
		setBusy(false);
	}

	return (
		<form>
			<textarea id='pending-review' ref={comment} placeholder="Leave a review summary comment"></textarea>
			<div className="form-actions">
				{isAuthor ? null : (
					<button
						id="request-changes"
						className='secondary'
						disabled={isBusy || pr.busy}
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
					disabled={isBusy || pr.busy}
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
				{mergeIcon}
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
				<Timestamp href={event.url} date={event.createdAt} />
			</div>
			{pr.revertable ?
				<div className="timeline-detail">
					<button className='secondary' disabled={pr.busy} onClick={revert}>Revert</button>
				</div> : null}
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
			<Timestamp date={event.createdAt} />
		</div>
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
					linked <a href={source.url}>#{source.number}</a> {source.title}
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
	return <>{arr.slice(0, -1).map(item => <>{item}, </>)} and {arr[arr.length - 1]}</>;
}

const AssignEventView = ({ event, isIssue }: { event: AssignEvent, isIssue: boolean }) => {
	const { actor, assignees } = event;
	const joinedAssignees = joinWithAnd(assignees.map(a => <AuthorLink key={a.id} for={a} />));
	return (
		<div className="comment-container commit">
			<div className="commit-message">
				<div className="avatar-container">
					<Avatar for={actor} />
				</div>
				<AuthorLink for={actor} />
				<div className="message">
					{isIssue
						? <>assigned {joinedAssignees}</>
						: <>assigned {joinedAssignees} to this pull request</>}
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