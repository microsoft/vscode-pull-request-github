/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { GitPullRequestCommentThread } from 'azure-devops-node-api/interfaces/GitInterfaces';
import { Identity } from 'azure-devops-node-api/interfaces/IdentitiesInterfaces';
import * as React from 'react';
// eslint-disable-next-line no-duplicate-imports
import { useContext, useRef, useState } from 'react';

import {
	CommitEvent,
	HeadRefDeleteEvent,
	isSystemThread,
	isUserCommentThread,
	MergedEvent,
	ReviewEvent,
} from '../../src/common/timelineEvent';
import { groupBy } from '../../src/common/utils';
import PullRequestContext from '../common/context';
import { CommentBody, CommentView, ReplyToThread } from './comment';
import { commitIcon, mergeIcon } from './icon';
import { nbsp, Spaced } from './space';
// eslint-disable-next-line import/no-named-as-default
import Timestamp from './timestamp';
import { AuthorLink, Avatar } from './user';
// import { isUserThread } from '../../src/azdo/utils';

export const Timeline = ({ threads, currentUser }: { threads: GitPullRequestCommentThread[]; currentUser: Identity }) => (
	<>
		{threads
			.sort((a, b) => new Date(b.publishedDate).getTime() - new Date(a.publishedDate).getTime())
			.map(
				thread =>
					// TODO: Maybe make TimelineEvent a tagged union type?
					isUserCommentThread(thread) ? (
						<CommentEventView key={thread.id} thread={thread} currentUser={currentUser} />
					) : isSystemThread(thread) ? (
						<SystemThreadView key={thread.id} thread={thread} />
					) : null,
				// isCommitEvent(event)
				// 	? <CommitEventView key={event.id} {...event} />
				// 	:
				// isReviewEvent(event)
				// 	? <ReviewEventView key={event.id} {...event} />
				// 	:
				// isCommentEvent(event)
				// 	? <CommentEventView key={event.id} {...event} />
				// 	:
				// isMergedEvent(event)
				// 	? <MergedEventView key={event.id} {...event} />
				// 	:
				// isAssignEvent(event)
				// 	? <AssignEventView key={event.id} {...event} />
				// 	:
				// isHeadDeleteEvent(event)
				// 	? <HeadDeleteEventView key={event.id} {...event} />
				// 	: null
			)}
	</>
);

export default Timeline;

export const SystemThreadView = ({ thread }: { thread: GitPullRequestCommentThread }) => {
	const identities = (thread.identities && Object.values(thread.identities)) || [];

	return (
		<div className="comment-container commit">
			<div className="commit-message">
				{commitIcon}
				{nbsp}
				{identities.length > 0 ? (
					<>
						<div className="avatar-container">
							<Avatar url={identities[0].profileUrl} avatarUrl={identities[0]['_links']?.['avatar']?.['href']} />
						</div>
						<AuthorLink url={identities[0].profileUrl} text={identities[0].displayName} />
					</>
				) : null}

				<div className="message">{thread.comments[0].content}</div>
			</div>
			{nbsp}
			<div className="system-timestamp">
				<Timestamp date={thread.publishedDate} />
			</div>
		</div>
	);
};

export const CommitEventView = (event: CommitEvent) => (
	<div className="comment-container commit">
		<div className="commit-message">
			{commitIcon}
			{nbsp}
			<div className="avatar-container">
				<Avatar url={event.author.url} avatarUrl={event.author.avatarUrl} />
			</div>
			<AuthorLink url={event.author.url} text={event.author.name} />
			<a className="message" href={event.htmlUrl}>
				{event.message}
			</a>
		</div>
		<a className="sha" href={event.htmlUrl}>
			{event.sha.slice(0, 7)}
		</a>
		{nbsp}
		<Timestamp date={event.authoredDate} />
	</div>
);

const association = ({ authorAssociation }: ReviewEvent, format = (assoc: string) => `(${assoc.toLowerCase()})`) =>
	authorAssociation.toLowerCase() === 'user'
		? format('you')
		: authorAssociation && authorAssociation !== 'NONE'
		? format(authorAssociation)
		: null;

const positionKey = (comment: GitPullRequestCommentThread) =>
	// comment.position !== null
	// 		? `pos:${comment.position}`
	// 		: `ori:${comment.originalPosition}`;
	comment.threadContext?.rightFileStart?.line ?? comment.threadContext?.leftFileStart?.line;

const groupCommentsByPath = (comments: GitPullRequestCommentThread[]) =>
	groupBy(comments, comment => `${comment.threadContext.filePath}:${positionKey(comment)}`);

const DESCRIPTORS = {
	PENDING: 'will review',
	COMMENTED: 'reviewed',
	CHANGES_REQUESTED: 'requested changes',
	APPROVED: 'approved',
};

const reviewDescriptor = (state: string) => DESCRIPTORS[state] || 'reviewed';

export const ReviewEventView = (event: ReviewEvent) => {
	const comments = groupCommentsByPath(event.comments);
	const reviewIsPending = event.state.toLocaleUpperCase() === 'PENDING';
	return (
		<div className="comment-container comment">
			<div className="review-comment-container">
				<div className="review-comment-header">
					<Spaced>
						<Avatar url={event.user.url} avatarUrl={event.user.avatarUrl} />
						<AuthorLink url={event.user.url} text={event.user.name} />
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
				{/* {event.state !== 'PENDING' && event.body ? <CommentBody body={event.body} bodyHTML={event.bodyHTML} /> : null} */}
				<div className="comment-body review-comment-body">
					{Object.entries(comments).map(([key, thread]) => (
						<div className="diff-container">
							{/* <Diff key={key}
									comment={thread[0]}
									hunks={thread[0].diffHunks}
									outdated={thread[0].position === null}
									path={thread[0].path} /> */}
							{/* {thread.map(c => <CommentView {...c} pullRequestReviewId={event.id} />)} */}
						</div>
					))}
				</div>
				{reviewIsPending ? <AddReviewSummaryComment /> : null}
			</div>
		</div>
	);
};

function AddReviewSummaryComment() {
	const { requestChanges, submit } = useContext(PullRequestContext);
	const comment = useRef<HTMLTextAreaElement>();
	return (
		<div className="comment-form">
			<textarea ref={comment} placeholder="Leave a review summary comment"></textarea>
			<div className="form-actions">
				<button id="request-changes" onClick={() => requestChanges(comment.current.value)}>
					Request Changes
				</button>
				{/* <button id='approve'
				onClick={() => votePullRequest(comment.current.value)}>Approve</button> */}
				<button id="submit" onClick={() => submit(comment.current.value)}>
					Comment
				</button>
			</div>
		</div>
	);
}

const CommentEventView = ({ thread, currentUser }: { thread: GitPullRequestCommentThread; currentUser: Identity }) => {
	const { replyThread, openDiff, changeThreadStatus } = useContext(PullRequestContext);
	const [inEditMode, setEditMode] = useState(false);

	const onCancel = () => {
		setEditMode(false);
	};

	const onSave = async text => {
		try {
			await replyThread(text, thread);
		} finally {
			setEditMode(false);
		}
	};

	const onThreadStatusChange = async status => {
		await changeThreadStatus(parseInt(status), thread);
	};

	return (
		<div className="thread-container">
			{!!thread.threadContext && !!thread.threadContext.filePath ? (
				<div className="diff-container diff">
					<div className="diffHeader">
						<a className="diffPath" onClick={() => openDiff(thread)}>
							{thread.threadContext.filePath}
						</a>
					</div>
				</div>
			) : null}
			{thread.comments.map(c => (
				<CommentView
					key={c.id}
					headerInEditMode
					{...c}
					canEdit={c.author.id === currentUser.id}
					threadId={thread.id}
					isFirstCommentInThread={c.id === 1}
					threadStatus={thread.status}
					changeThreadStatus={status => onThreadStatusChange(status)}
				/>
			))}
			{!inEditMode ? (
				<div className="reply-thread">
					<button title="Reply" onClick={() => setEditMode(true)}>
						Reply
					</button>
				</div>
			) : (
				/* <input id='reply'	value='Reply' onClick={ (e) => { e.}} className='secondary' disabled={isBusy} /> */
				<ReplyToThread onSave={onSave} onCancel={onCancel} />
			)}
		</div>
	);
};

export const MergedEventView = (event: MergedEvent) => (
	<div className="comment-container commit">
		<div className="commit-message">
			{mergeIcon}
			{nbsp}
			<div className="avatar-container">
				<Avatar url={event.user.url} avatarUrl={event.user.avatarUrl} />
			</div>
			<AuthorLink url={event.user.url} text={event.user.name} />
			<div className="message">
				merged commit{nbsp}
				<a className="sha" href={event.commitUrl}>
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

export const HeadDeleteEventView = (event: HeadRefDeleteEvent) => (
	<div className="comment-container commit">
		<div className="commit-message">
			<div className="avatar-container">
				<Avatar url={event.actor.url} avatarUrl={event.actor.avatarUrl} />
			</div>
			<AuthorLink url={event.actor.url} text={event.actor.name} />
			<div className="message">
				deleted the {event.headRef} branch{nbsp}
			</div>
			<Timestamp date={event.createdAt} />
		</div>
	</div>
);

// TODO: We should show these, but the pre-React overview page didn't. Add
// support in a separate PR.
// export const AssignEventView = (event: AssignEvent) => null;
