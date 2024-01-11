/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import React, { useContext, useRef, useState } from 'react';
import { IComment } from '../../src/common/comment';
import {
	AssignEvent,
	CommentEvent,
	CommitEvent,
	EventType,
	HeadRefDeleteEvent,
	MergedEvent,
	ReviewEvent,
	TimelineEvent,
} from '../../src/common/timelineEvent';
import { groupBy, UnreachableCaseError } from '../../src/common/utils';
import PullRequestContext from '../common/context';
import {  CommentView } from './comment';
import Diff from './diff';
import { commitIcon, mergeIcon, plusIcon } from './icon';
import { nbsp } from './space';
import { Timestamp } from './timestamp';
import { AuthorLink, Avatar } from './user';

export const Timeline = ({ events }: { events: TimelineEvent[] }) => (
	<>
	{events.map(event => {
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
				return <AssignEventView key={`assign${event.id}`} {...event} />;
			case EventType.HeadRefDeleted:
				return <HeadDeleteEventView key={`head${event.id}`} {...event} />;
			case EventType.NewCommitsSinceReview:
				return <NewCommitsSinceReviewEventView key={`newCommits${event.id}`} />;
			default:
				throw new UnreachableCaseError(event);
		}
	})}
	</>
);

export default Timeline;

const CommitEventView = (event: CommitEvent) => (
	<div className="comment-container commit">
		<div className="commit-message">
			{commitIcon}
			{nbsp}
			<div className="avatar-container">
				<Avatar for={event.author} />
			</div>
			<AuthorLink for={event.author} />
			<div className="message-container">
				<a className="message" href={event.htmlUrl} title={event.htmlUrl}>
					{event.message.substr(0, event.message.indexOf('\n') > -1 ? event.message.indexOf('\n') : event.message.length)}
				</a>
			</div>
		</div>
		<div className="sha-with-timestamp">
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
	return (
		<form>
			<textarea ref={comment} placeholder="Leave a review summary comment"></textarea>
			<div className="form-actions">
				{isAuthor ? null : (
					<button
						id="request-changes"
						className='secondary'
						onClick={(event) => {
							event.preventDefault();
							requestChanges(comment.current!.value);
						}}
					>
						Request Changes
					</button>
				)}
				{isAuthor ? null : (
					<button
						id="approve" className='secondary'
						onClick={(event) => {
							event.preventDefault();
							approve(comment.current!.value);
						}}
					>
						Approve
					</button>
				)}
				<button
					onClick={(event) => {
						event.preventDefault();
						submit(comment.current!.value);
					}}
				>Submit Review</button>
			</div>
		</form>
	);
}

const CommentEventView = (event: CommentEvent) => <CommentView headerInEditMode comment={event} />;

const MergedEventView = (event: MergedEvent) => (
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
	</div>
);

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

// TODO: We should show these, but the pre-React overview page didn't. Add
// support in a separate PR.
const AssignEventView = (event: AssignEvent) => null;
