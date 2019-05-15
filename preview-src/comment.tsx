import * as React from 'react';
import { useContext, useState, useEffect, useRef, useCallback, useMemo } from 'react';

import Markdown from './markdown';
import { Spaced, nbsp } from './space';
import { Avatar, AuthorLink } from './user';
import Timestamp from './timestamp';
import { Comment } from '../src/common/comment';
import { PullRequest } from './cache';
import PullRequestContext from './context';
import { editIcon, deleteIcon } from './icon';

export type Props = Partial<Comment & PullRequest> & {
	headerInEditMode?: boolean
	isPRDescription?: boolean
};

export function CommentView(comment: Props) {
	const { id, pullRequestReviewId, canEdit, canDelete, bodyHTML, body, isPRDescription } = comment;
	const [ bodyMd, setBodyMd ] = useState(body);
	const { deleteComment, editComment, setDescription, pr } = useContext(PullRequestContext);
	const currentDraft = pr.pendingCommentDrafts && pr.pendingCommentDrafts[id];
	const [inEditMode, setEditMode] = useState(!!currentDraft);
	const [showActionBar, setShowActionBar] = useState(false);

	useEffect(() => {
		if (body !== bodyMd) {
			setBodyMd(body);
		}
	}, [body]);

	if (inEditMode) {
		return React.cloneElement(
				comment.headerInEditMode
					? <CommentBox for={comment} /> : <></>, {}, [
			<EditComment id={id}
				body={currentDraft || body}
				onCancel={
					() => {
						if (pr.pendingCommentDrafts) {
							delete pr.pendingCommentDrafts[id];
						}
						setEditMode(false);
					}
				}
				onSave={
					async text => {
						try {
							if (isPRDescription) {
								await setDescription(text);
							} else {
								await editComment({ comment: comment as Comment, text });
							}
							setBodyMd(text);
						} finally {
							setEditMode(false);
						}
					}
				} />
			]);
	}

	return <CommentBox
		for={comment}
		onMouseEnter={() => setShowActionBar(true)}
		onMouseLeave={() => setShowActionBar(false)}
	>{ ((canEdit || canDelete) && showActionBar)
		? <div className='action-bar comment-actions'>
				{canEdit ? <button onClick={() => setEditMode(true)}>{editIcon}</button> : null}
				{canDelete ? <button onClick={() => deleteComment({ id, pullRequestReviewId })}>{deleteIcon}</button> : null}
			</div>
		: null
	}
			<CommentBody bodyHTML={bodyHTML} body={bodyMd} />
		</CommentBox>;
}

type CommentBoxProps = {
	for: Partial<Comment & PullRequest>
	header?: React.ReactChild
	onMouseEnter?: any
	onMouseLeave?: any
	children?: any
};

function CommentBox({
	for: comment,
	onMouseEnter, onMouseLeave, children }: CommentBoxProps) {
	const	{ user, author, createdAt, htmlUrl } = comment;
	return <div className='comment-container comment review-comment'
		{...{onMouseEnter, onMouseLeave}}
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
			</div>
			{children}
		</div>
	</div>;
}

type FormInputSet ={
	[name: string]: HTMLInputElement | HTMLTextAreaElement
}

type EditCommentProps = {
	id: number
	body: string
	onCancel: () => void
	onSave: (body: string) => Promise<any>
}

function EditComment({ id, body, onCancel, onSave }: EditCommentProps) {
	const { updateDraft } = useContext(PullRequestContext);
	const draftComment = useRef<{body: string, dirty: boolean}>({ body, dirty: false });
	const form = useRef<HTMLFormElement>();

	useEffect(() => {
		const interval = setInterval(
			() => {
				if (draftComment.current.dirty) {
					updateDraft(id, draftComment.current.body);
					draftComment.current.dirty = false;
				}
			},
			500);
		return () => clearInterval(interval);
	},
	[draftComment]);

	const submit = useCallback(
		async (formElement: HTMLFormElement) => {
			console.log('submitting');
			const { markdown, submitButton }: FormInputSet = formElement;
			submitButton.disabled = true;
			try {
				await onSave(markdown.value);
			} finally {
				submitButton.disabled = false;
			}
		},
		[onSave]);

	const onKeyDown = useCallback(
		e => {
			if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
				submit(form.current);
			}
		},
		[form]
	);

	const onInput = useCallback(
		e => {
			draftComment.current.body = (e.target as any).value;
			draftComment.current.dirty = true;
		},
		[draftComment]);

	return <form ref={form} onSubmit={event => {
		event.preventDefault();
		submit(event.target as HTMLFormElement);
	}}>
		<textarea
			name='markdown'
			defaultValue={body}
			onKeyDown={onKeyDown}
			onInput={onInput}
		/>
		<div className='form-actions'>
			<button className='secondary' onClick={onCancel}>Cancel</button>
			<input type='submit' name='submitButton' value='Save' />
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
		return <form id='comment-form' className='comment-form main-comment-form' onSubmit={onSubmit}>
			<textarea id='comment-textarea'
				name='body'
				onInput={({ target }) =>
					updatePR({ pendingCommentText: (target as any).value })}
				value={pendingCommentText}
				placeholder='Leave a comment' />
			<div className='form-actions'>
				<button id='close' className='secondary'>Close Pull Request</button>
				<button id='request-changes'
					disabled={!pendingCommentText}
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