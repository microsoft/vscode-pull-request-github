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
	HeadRefDeleteEvent,
	isAssignEvent,
	isCommentEvent,
	isCommitEvent,
	isHeadDeleteEvent,
	isMergedEvent,
	isNewCommitsSinceReviewEvent,
	isReviewEvent,
	MergedEvent,
	ReviewEvent,
	TimelineEvent,
} from '../../src/common/timelineEvent';
import { groupBy } from '../../src/common/utils';
import PullRequestContext from '../common/context';
import { CommentBody, CommentView } from './comment';
import Diff from './diff';
import { commitIcon, mergeIcon, plusIcon } from './icon';
import { nbsp, Spaced } from './space';
import { Timestamp } from './timestamp';
import { AuthorLink, Avatar } from './user';

export const Timeline = ({ events }: { events: TimelineEvent[] }) => (
	<>
		{events.map(event =>
			// TODO: Maybe make TimelineEvent a tagged union type?
			isCommitEvent(event) ? (
				<CommitEventView key={`commit${event.id}`} {...event} />
			) : isReviewEvent(event) ? (
				<ReviewEventView key={`review${event.id}`} {...event} />
			) : isCommentEvent(event) ? (
				<CommentEventView key={`comment${event.id}`} {...event} />
			) : isMergedEvent(event) ? (
				<MergedEventView key={`merged${event.id}`} {...event} />
			) : isAssignEvent(event) ? (
				<AssignEventView key={`assign${event.id}`} {...event} />
			) : isHeadDeleteEvent(event) ? (
				<HeadDeleteEventView key={`head${event.id}`} {...event} />
			) : isNewCommitsSinceReviewEvent(event) ? (
				<NewCommitsSinceReviewEventView key={`newCommits${event.id}`} />
			) : null,
		)}
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
			<a className="message" href={event.htmlUrl} title={event.htmlUrl}>
				{event.message}
			</a>
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

const association = ({ authorAssociation }: ReviewEvent, format = (assoc: string) => `(${assoc.toLowerCase()})`) =>
	authorAssociation.toLowerCase() === 'user'
		? format('you')
		: authorAssociation && authorAssociation !== 'NONE'
		? format(authorAssociation)
		: null;

const positionKey = (comment: IComment) =>
	comment.position !== null ? `pos:${comment.position}` : `ori:${comment.originalPosition}`;

const groupCommentsByPath = (comments: IComment[]) =>
	groupBy(comments, comment => comment.path + ':' + positionKey(comment));

const DESCRIPTORS = {
	PENDING: 'will review',
	COMMENTED: 'reviewed',
	CHANGES_REQUESTED: 'requested changes',
	APPROVED: 'approved',
};

const reviewDescriptor = (state: string) => DESCRIPTORS[state] || 'reviewed';

const ReviewEventView = (event: ReviewEvent) => {
	const comments = groupCommentsByPath(event.comments);
	const reviewIsPending = event.state.toLocaleUpperCase() === 'PENDING';
	return (
		<div id={reviewIsPending ? 'pending-review' : null} className="comment-container comment">
			<div className="review-comment-container">
				<div className="review-comment-header">
					<Spaced>
						<Avatar for={event.user} />
						<AuthorLink for={event.user} />
						{association(event)}
						{reviewIsPending ? (
							<em>review pending</em>
						) : (
							<>
								{reviewDescriptor(event.state)}
								{nbsp}
								<Timestamp href={event.htmlUrl} date={event.submittedAt} />
							</>
						)}
					</Spaced>
				</div>
				{event.state !== 'PENDING' && event.body ? (
					<CommentBody body={event.body} bodyHTML={event.bodyHTML} canApplyPatch={false} />
				) : null}
				<div className="comment-body review-comment-body">
					{Object.entries(comments).map(([key, thread]) => {
						return <CommentThread key={key} thread={thread} event={event} />;
					})}
				</div>
				{reviewIsPending ? <AddReviewSummaryComment /> : null}
			</div>
		</div>
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
					<Diff hunks={comment.diffHunks} />
					{thread.map(c => (
						<CommentView key={c.id} {...c} pullRequestReviewId={event.id} />
					))}
					{resolvePermission ? (
						<div>
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
		<div className="comment-form">
			<textarea ref={comment} placeholder="Leave a review summary comment"></textarea>
			<div className="form-actions">
				{isAuthor ? null : (
					<button
						id="request-changes"
						className="push-right"
						onClick={() => requestChanges(comment.current.value)}
					>
						Request Changes
					</button>
				)}
				{isAuthor ? null : (
					<button id="approve" onClick={() => approve(comment.current.value)}>
						Approve
					</button>
				)}
				<button
					id="submit"
					className={isAuthor ? 'push-right' : ''}
					onClick={() => submit(comment.current.value)}
				>
					Submit Review
				</button>
			</div>
		</div>
	);
}

const CommentEventView = (event: CommentEvent) => <CommentView headerInEditMode {...event} />;

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
