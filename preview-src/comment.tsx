import * as React from 'react';
import { useContext, useState, useEffect, useRef } from 'react';

import Markdown from './markdown';
import { Spaced, nbsp } from './space';
import { Avatar, AuthorLink } from './user';
import Timestamp from './timestamp';
import { Comment } from '../src/common/comment';
import { PullRequest } from './cache';
import PullRequestContext from './context';
import { editIcon, deleteIcon } from './icon';

export type Props = Partial<Comment & PullRequest>;

export function CommentView(comment: Props) {
	const { id, pullRequestReviewId, canEdit, canDelete, user, author, htmlUrl, createdAt, bodyHTML, body, } = comment;
	const [ bodyMd, setBodyMd ] = useState(body);
	const { deleteComment, editComment, pr } = useContext(PullRequestContext);
	const [inEditMode, setEditMode] = useState(!!(pr.pendingCommentDrafts && pr.pendingCommentDrafts[id]));
	const [showActionBar, setShowActionBar] = useState(false);

	useEffect(() => {
		if (body !== bodyMd) {
			setBodyMd(body);
		}
	}, [body]);

	if (inEditMode) {
		return <EditComment id={id}
			body={bodyMd}
			onCancel={
				() => setEditMode(false)
			}
			onSave={
				async text => {
					try {
						await editComment({ comment: comment as Comment, text });
						setBodyMd(text);
					} finally {
						setEditMode(false);
					}
				}
			} />;
	}

	return <div className='comment-container comment review-comment'
		onMouseEnter={() => setShowActionBar(true)}
		onMouseLeave={() => setShowActionBar(false)}
	>
		<div className='review-comment-container'>
			<div className='review-comment-header'>
				<Spaced>
					<Avatar for={user || author} />
					<AuthorLink for={user || author} />
					{
						createdAt
							? <>
									commented{nbsp}
									<Timestamp href={htmlUrl} date={createdAt} />
								</>
							: <em>pending</em>
					}
				</Spaced>
				{ ((canEdit || canDelete) && showActionBar)
					? <div className='action-bar comment-actions'>
							{canEdit ? <button onClick={() => setEditMode(true)}>{editIcon}</button> : null}
							{canDelete ? <button onClick={() => deleteComment({ id, pullRequestReviewId })}>{deleteIcon}</button> : null}
						</div>
					: null
				}
			</div>
			<CommentBody bodyHTML={bodyHTML} body={bodyMd} />
		</div>
	</div>;
}

function EditComment({ id, body, onCancel, onSave }: { id: number, body: string, onCancel: () => void, onSave: (body: string) => void}) {
	const draftComment = useRef<{body: string, dirty: boolean}>({ body, dirty: false });
	const { updateDraft } = useContext(PullRequestContext);
	useEffect(() => {
		const interval = setInterval(
			() => {
				console.log(JSON.stringify(draftComment.current))
				draftComment.current.dirty && updateDraft(id, draftComment.current.body)
			},
			500);
		return () => clearInterval(interval);
	});
	return <form onSubmit={
		event => {
			event.preventDefault();
			const { markdown }: any = event.target;
			onSave(markdown.value);
		}
	}>
		<textarea
			name='markdown'
			defaultValue={body}
			onInput={
				e => {
					draftComment.current.body = (e.target as any).value;
					draftComment.current.dirty = true;
				}
			}
		/>
		<div className='form-actions'>
			<button className='secondary' onClick={onCancel}>Cancel</button>
			<input type='submit' value='Save' />
		</div>
	</form>;
}

export interface Embodied {
	bodyHTML?: string;
	body?: string;
}

export const CommentBody = ({ bodyHTML, body }: Embodied) =>
	body
		? <Markdown className='comment-body' src={body} />
		:
	bodyHTML
		? <div className='comment-body'
				dangerouslySetInnerHTML={ {__html: bodyHTML }} />
		:
	<div className='comment-body'><em>No description provided.</em></div>;

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
					disabled={!pendingCommentText} />
			</div>
		</form>;

		function onSubmit(evt) {
			evt.preventDefault();
			comment((evt.target as any).body.value);
		}
	}