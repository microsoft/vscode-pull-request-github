import * as React from 'react';
import { useContext } from 'react';

import Markdown from './markdown';
import { Spaced } from './space';
import { Avatar, AuthorLink } from './user';
import Timestamp from './timestamp';
import { Comment } from '../src/common/comment';
import { PullRequest } from './cache';
import PullRequestContext from './actions';

export const CommentView = ({ user, htmlUrl, createdAt, bodyHTML, body }: Partial<Comment>) =>
	<div className='comment-container comment review-comment'>
		<div className='review-comment-container'>
			<div className='review-comment-header'>
				<Spaced>
					<Avatar for={user} />
					<AuthorLink for={user} />
					commented
					<Timestamp href={htmlUrl} date={createdAt} />
				</Spaced>
			</div>
			<CommentBody bodyHTML={bodyHTML} body={body} />
		</div>
	</div>;

export interface Embodied {
	bodyHTML?: string;
	body?: string;
}

export const CommentBody = ({ bodyHTML, body }: Embodied) =>
	bodyHTML
	? <div className='comment-body'
		dangerouslySetInnerHTML={ {__html: bodyHTML }} />
	:
	<Markdown className='comment-body' src={body} />;

export function AddComment({ pendingCommentText }: PullRequest) {
		const { updatePR, comment } = useContext(PullRequestContext);
		return <form id='comment-form' className='comment-form' onSubmit={onSubmit}>
			<textarea id='comment-textarea'
				name='body'
				onInput={({ target }) =>
					updatePR({ pendingCommentText: (target as any).value })}
				value={pendingCommentText}
				placeholder='Leave a comment' />
			<div className='form-actions'>
				<button id='close' className='secondary'>Close Pull Request</button>
				<button id='request-changes'
					disabled={!!pendingCommentText}
					className='secondary'>Request Changes</button>
				<button id='approve'
					className='secondary'>Approve</button>
				<input id='reply'
					value='Comment'
					type='submit'
					className='reply-button'
					disabled={!!pendingCommentText} />
			</div>
		</form>;

		function onSubmit(evt) {
			evt.preventDefault();
			comment((evt.target as any).body.value);
		}
	}