/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import { useContext, useRef } from 'react';

import { IComment } from '../../src/common/comment';
import { TimelineEvent, isReviewEvent, isCommitEvent, isCommentEvent, isMergedEvent, isAssignEvent, ReviewEvent, CommitEvent, CommentEvent, MergedEvent, AssignEvent, isHeadDeleteEvent, HeadRefDeleteEvent } from '../../src/common/timelineEvent';
import { commitIcon, mergeIcon } from './icon';
import { Avatar, AuthorLink } from './user';
import { groupBy } from '../../src/common/utils';
import { Spaced, nbsp } from './space';
import Timestamp from './timestamp';
import { CommentView, CommentBody } from './comment';
import Diff from './diff';
import PullRequestContext from '../common/context';

export const Timeline = ({ events }: { events: TimelineEvent[] }) =>
	<>{
		events.map(event =>
			// TODO: Maybe make TimelineEvent a tagged union type?
			isCommitEvent(event)
				? <CommitEventView key={event.id} {...event} />
				:
			isReviewEvent(event)
				? <ReviewEventView key={event.id} {...event} />
				:
			isCommentEvent(event)
				? <CommentEventView key={event.id} {...event} />
				:
			isMergedEvent(event)
				? <MergedEventView key={event.id} {...event} />
				:
			isAssignEvent(event)
				? <AssignEventView key={event.id} {...event} />
				:
			isHeadDeleteEvent(event)
				? <HeadDeleteEventView key={event.id} {...event} />
				: null
		)
	}</>;

export default Timeline;

const CommitEventView = (event: CommitEvent) =>
	<div className='comment-container commit'>
		<div className='commit-message'>
			{commitIcon}{nbsp}
			<div className='avatar-container'>
				<Avatar for={event.author} />
			</div>
			<AuthorLink for={event.author} />
			<a className='message' href={event.htmlUrl}>{event.message}</a>
		</div>
		<a className='sha' href={event.htmlUrl}>{event.sha.slice(0, 7)}</a>
	</div>;

const association = (
	{ authorAssociation }: ReviewEvent,
	format=(assoc: string) => `(${assoc.toLowerCase()})`) =>
		authorAssociation.toLowerCase() === 'user'
			? format('you')
			:
		(authorAssociation && authorAssociation !== 'NONE')
			? format(authorAssociation)
			: null;

const positionKey = (comment: IComment) =>
	comment.position !== null
		? `pos:${comment.position}`
		: `ori:${comment.originalPosition}`;

const groupCommentsByPath = (comments: IComment[]) =>
	groupBy(comments,
		comment => comment.path + ':' + positionKey(comment));

const DESCRIPTORS = {
	PENDING: 'will review',
	COMMENTED: 'reviewed',
	CHANGES_REQUESTED: 'requested changes',
	APPROVED: 'approved',
};

const reviewDescriptor = (state: string) =>
	DESCRIPTORS[state] || 'reviewed';

const ReviewEventView = (event: ReviewEvent) => {
	const comments = groupCommentsByPath(event.comments);
	const reviewIsPending = event.state.toLocaleUpperCase() === 'PENDING';
	return <div className='comment-container comment'>
		<div className='review-comment-container'>
			<div className='review-comment-header'>
				<Spaced>
					<Avatar for={event.user} />
					<AuthorLink for={event.user} />{association(event)}
					{ reviewIsPending
						? <em>review pending</em>
						: <>
								{reviewDescriptor(event.state)}{nbsp}
								<Timestamp href={event.htmlUrl} date={event.submittedAt} />
						</> }
				</Spaced>
			</div>
			{
				event.state !== 'PENDING' && event.body
					? <CommentBody body={event.body} bodyHTML={event.bodyHTML} />
					: null
			}
			<div className='comment-body review-comment-body'>{
				Object.entries(comments)
					.map(
						([key, thread]) =>
							<div className='diff-container'>
								<Diff key={key}
									comment={thread[0]}
									hunks={thread[0].diffHunks}
									outdated={thread[0].position === null}
									path={thread[0].path} />
								{thread.map(c => <CommentView {...c} pullRequestReviewId={event.id} />)}
							</div>
					)
			}</div>
			{
				reviewIsPending ?
					<AddReviewSummaryComment />
				: null
			}
		</div>
	</div>;
};

function AddReviewSummaryComment() {
	const { requestChanges, approve, submit } = useContext(PullRequestContext);
	const comment = useRef<HTMLTextAreaElement>();
	return <div className='comment-form'>
		<textarea ref={comment} placeholder='Leave a review summary comment'></textarea>
		<div className='form-actions'>
			<button id='request-changes'
				onClick={() => requestChanges(comment.current.value)}>Request Changes</button>
			<button id='approve'
				onClick={() => approve(comment.current.value)}>Approve</button>
			<button id='submit'
				onClick={() => submit(comment.current.value)}>Submit</button>
		</div>
	</div>;
}

const CommentEventView = (event: CommentEvent) => <CommentView headerInEditMode {...event} />;

const MergedEventView = (event: MergedEvent) =>
	<div className='comment-container commit'>
		<div className='commit-message'>
			{mergeIcon}{nbsp}
			<div className='avatar-container'>
				<Avatar for={event.user} />
			</div>
			<AuthorLink for={event.user} />
			<div className='message'>
				merged commit{nbsp}
				<a className='sha' href={event.commitUrl}>{event.sha.substr(0, 7)}</a>{nbsp}
				into {event.mergeRef}{nbsp}
			</div>
			<Timestamp href={event.url} date={event.createdAt} />
		</div>
	</div>;

const HeadDeleteEventView = (event: HeadRefDeleteEvent) =>
	<div className='comment-container commit'>
		<div className='commit-message'>
			<div className='avatar-container'>
				<Avatar for={event.actor} />
			</div>
			<AuthorLink for={event.actor} />
			<div className='message'>
				deleted the {event.headRef} branch{nbsp}
			</div>
			<Timestamp date={event.createdAt} />
		</div>
	</div>;

// TODO: We should show these, but the pre-React overview page didn't. Add
// support in a separate PR.
const AssignEventView = (event: AssignEvent) => null;
