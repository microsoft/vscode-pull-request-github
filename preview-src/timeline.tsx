import * as React from 'react';

import { Comment } from '../src/common/comment';
import { TimelineEvent, isReviewEvent, isCommitEvent, isCommentEvent, isMergedEvent, isAssignEvent, ReviewEvent, CommitEvent, CommentEvent, MergedEvent, AssignEvent } from '../src/common/timelineEvent';
import { commitIcon } from './icon';
import { Avatar, AuthorLink } from './user';
import { groupBy } from '../src/common/utils';
import { Spaced } from './space';
import Timestamp from './timestamp';
import { CommentView } from './comment';
import Diff from './diff';

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
				: null
		)
	}</>;

export default Timeline;

export const CommitEventView = (event: CommitEvent) =>
	<div className='comment-container commit'>
		<div className='commit-message'>
			{commitIcon}
			<div className='avatar-container'>
				<Avatar for={event.author} />
			</div>
			<AuthorLink for={event.author} />
			<div className='message'>{event.message}</div>
		</div>
		<a className='sha' href={event.url}>{event.sha.slice(0, 7)}</a>
	</div>;

const association = (
	{ authorAssociation }: ReviewEvent,
	format=(assoc: string) => `(${assoc.toLowerCase()})`) =>
		(authorAssociation && authorAssociation !== 'NONE')
			? format(authorAssociation)
			: null;

const positionKey = (comment: Comment) =>
	comment.position !== null
		? `pos:${comment.position}`
		: `ori:${comment.originalPosition}`;

const groupCommentsByPath = (comments: Comment[]) =>
	groupBy(comments,
		comment => comment.path + ':' + positionKey(comment));

const ReviewEventView = (event: ReviewEvent) => {
	const comments = groupCommentsByPath(event.comments);
	return <div className='comment-container comment'>
		<div className='review-comment-container'>
			<div className='review-comment-header'>
				<Spaced>
					<Avatar for={event.user} />
					<AuthorLink for={event.user} />{association(event)}
					reviewed
					<Timestamp href={event.htmlUrl} date={event.submittedAt} />
				</Spaced>
			</div>
			<div className='comment-body review-comment-body'>{
				Object.entries(comments)
					.map(
						([key, thread]) =>
							<div className='diff-container'>
								<Diff key={key}
									hunks={thread[0].diffHunks}
									outdated={thread[0].position === null}
									path={thread[0].path} />
								{thread.map(c => <CommentView {...c} />)}
							</div>
					)
			}</div>
		</div>
	</div>;
};

const CommentEventView = (event: CommentEvent) => <CommentView {...event} />;
const MergedEventView = (event: MergedEvent) => <h1>Merged: {event.id}</h1>;
const AssignEventView = (event: AssignEvent) => <h1>Assign: {event.id}</h1>;
