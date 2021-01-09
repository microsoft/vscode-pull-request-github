/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import { useContext, useState, useEffect, useRef, useCallback } from 'react';

import { Spaced, nbsp } from './space';
import { Avatar, AuthorLink } from './user';
import Timestamp from './timestamp';
import { PullRequest, ReviewType } from '../common/cache';
import PullRequestContext from '../common/context';
import { editIcon, commentIcon } from './icon';
import { useStateProp } from '../common/hooks';
import emitter from '../common/events';
import { Dropdown } from './dropdown';
import { Comment, PullRequestStatus } from 'azure-devops-node-api/interfaces/GitInterfaces';

export type Props = Partial<Comment> & {
	headerInEditMode?: boolean
	isPRDescription?: boolean,
	threadId: number,
	canEdit?: boolean
};

export function CommentView(comment: Props) {
	const { threadId, content, canEdit, isPRDescription } = comment;
	const id = threadId * 1000 + comment.id;
	const [bodyMd, setBodyMd] = useStateProp(content);
	const [bodyHTMLState, setBodyHtml] = useStateProp(content);
	const { editComment, setDescription, pr } = useContext(PullRequestContext);
	const currentDraft = pr.pendingCommentDrafts && pr.pendingCommentDrafts[id];
	const [inEditMode, setEditMode] = useState(!!currentDraft);
	const [showActionBar, setShowActionBar] = useState(false);

	if (inEditMode) {
		return React.cloneElement(
			comment.headerInEditMode
				? <CommentBox for={comment} /> : <></>, {}, [
			<EditComment id={id}
				body={currentDraft || bodyMd}
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
							const result = isPRDescription
								? await setDescription(text)
								: await editComment({ comment: comment, threadId, text });

							setBodyHtml(result.bodyHTML);
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
	>{showActionBar
		? <div className='action-bar comment-actions'>
			<button title='Quote reply' onClick={() => emitter.emit('quoteReply', bodyMd)}>{commentIcon}</button>
			{canEdit ? <button title='Edit comment' onClick={() => setEditMode(true)} >{editIcon}</button> : null}
			{/* {canDelete ? <button title='Delete comment' onClick={() => deleteComment({ id, pullRequestReviewId })} >{deleteIcon}</button> : null} */}
		</div>
		: null
		}
		<CommentBody comment={comment} bodyHTML={bodyHTMLState} body={bodyMd} />
	</CommentBox>;
}

type CommentBoxProps = {
	for: Partial<Comment>
	header?: React.ReactChild
	onMouseEnter?: any
	onMouseLeave?: any
	children?: any
};

function CommentBox({
	for: comment,
	onMouseEnter, onMouseLeave, children }: CommentBoxProps) {
	const { author, publishedDate, _links  } = comment;
	const htmlUrl = _links.self.href;
	return <div className='comment-container comment review-comment'
		{...{ onMouseEnter, onMouseLeave }}
	>
		<div className='review-comment-container'>
			<div className='review-comment-header'>
				<Spaced>
					<Avatar for={author} />
					<AuthorLink for={author} />
					{
						publishedDate
							? <>
								commented{nbsp}
								<Timestamp href={htmlUrl} date={publishedDate} />
							</>
							: <em>pending</em>
					}
					{/* {
						isDraft
							? <>
								<span className='pending-label'>Pending</span>
							</>
							: null
					} */}
				</Spaced>
			</div>
			{children}
		</div>
	</div>;
}

type FormInputSet = {
	[name: string]: HTMLInputElement | HTMLTextAreaElement
};

type EditCommentProps = {
	id: number
	body: string
	onCancel: () => void
	onSave: (body: string) => Promise<any>
};

function EditComment({ id, body, onCancel, onSave }: EditCommentProps) {
	const { updateDraft } = useContext(PullRequestContext);
	const draftComment = useRef<{ body: string, dirty: boolean }>({ body, dirty: false });
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
		async () => {
			const { markdown, submitButton }: FormInputSet = form.current;
			submitButton.disabled = true;
			try {
				await onSave(markdown.value);
			} finally {
				submitButton.disabled = false;
			}
		},
		[form, onSave]);

	const onSubmit = useCallback(
		event => {
			event.preventDefault();
			submit();
		},
		[submit]
	);

	const onKeyDown = useCallback(
		e => {
			if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
				e.preventDefault();
				submit();
			}
		},
		[submit]
	);

	const onInput = useCallback(
		e => {
			draftComment.current.body = (e.target as any).value;
			draftComment.current.dirty = true;
		},
		[draftComment]);

	return <form ref={form} onSubmit={onSubmit}>
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
	comment?: Comment;
	bodyHTML?: string;
	body?: string;
}

export const CommentBody = ({ comment, bodyHTML, body }: Embodied) => {
	if (!body && !bodyHTML) {
		return <div className='comment-body'><em>No description provided.</em></div>;
	}

	const { applyPatch } = useContext(PullRequestContext);
	const renderedBody = <div dangerouslySetInnerHTML={{ __html: bodyHTML }} />;

	const containsSuggestion = (body || bodyHTML).indexOf('```diff') > -1;
	const applyPatchButton = containsSuggestion
		? <button onClick={() => applyPatch(comment)}>Apply Patch</button>
		: <></>;

	return <div className='comment-body'>
		{renderedBody}
		{applyPatchButton}
	</div>;
};

export function AddComment({ pendingCommentText, state, hasWritePermission, isIssue }: PullRequest) {
	const { updatePR, comment, close } = useContext(PullRequestContext);
	const [isBusy, setBusy] = useState(false);
	const form = useRef<HTMLFormElement>();
	const textareaRef = useRef<HTMLTextAreaElement>();

	emitter.addListener('quoteReply', (message) => {
		updatePR({ pendingCommentText: `> ${message} \n\n` });
		textareaRef.current.scrollIntoView();
		textareaRef.current.focus();
	});

	const submit = useCallback(
		async (command: (body: string) => Promise<any> = comment) => {
			try {
				setBusy(true);
				const { body }: FormInputSet = form.current;
				await command(body.value);
				updatePR({ pendingCommentText: '' });
			} finally {
				setBusy(false);
			}
		},
		[comment, updatePR, setBusy]);

	const onSubmit = useCallback(
		e => {
			e.preventDefault();
			submit();
		},
		[submit]);

	const onKeyDown = useCallback(
		e => {
			if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
				submit();
			}
		},
		[submit]);

	const onClick = useCallback(
		e => {
			e.preventDefault();
			const { command } = e.target.dataset;
			submit({ close }[command]);
		},
		[submit, close]);

	return <form id='comment-form'
		ref={form}
		className='comment-form main-comment-form'
		onSubmit={onSubmit}>
		<textarea id='comment-textarea'
			name='body'
			ref={textareaRef}
			onInput={
				({ target }) =>
					updatePR({ pendingCommentText: (target as any).value })
			}
			onKeyDown={onKeyDown}
			value={pendingCommentText}
			placeholder='Leave a comment' />
		<div className='form-actions'>
			{hasWritePermission && !isIssue
				? <button id='close'
					className='secondary'
					disabled={isBusy || state !== PullRequestStatus.Active}
					onClick={onClick}
					data-command='close'>Close Pull Request</button>
				: null}
			<input id='reply'
				value='Comment'
				type='submit'
				className='secondary'
				disabled={isBusy || !pendingCommentText} />
		</div>
	</form>;
}

const COMMENT_METHODS = {
	comment: 'Comment',
	approve: 'Approve',
	requestChanges: 'Request Changes'
}

export const AddCommentSimple = (pr: PullRequest) => {
	const { updatePR, requestChanges, comment } = useContext(PullRequestContext);
	const textareaRef = useRef<HTMLTextAreaElement>();

	async function submitAction(selected: string): Promise<void> {
		const { value } = textareaRef.current;
		switch (selected) {
			case ReviewType.RequestChanges:
				await requestChanges(value);
				break;
			// case ReviewType.Approve:
			// 	await votePullRequest(value);
			// 	break;
			default:
				await comment(value);
		}
		updatePR({ pendingCommentText: '', pendingReviewType: undefined });
	}

	const onChangeTextarea = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
		updatePR({ pendingCommentText: e.target.value });
	}

	const availableActions = pr.isAuthor
		? { comment: 'Comment' }
		: COMMENT_METHODS;

	return <span>
		<textarea id='comment-textarea'
			name='body'
			placeholder='Leave a comment'
			ref={textareaRef}
			value={pr.pendingCommentText}
			onChange={onChangeTextarea} />
		<Dropdown options={availableActions} defaultOption='comment' submitAction={submitAction} /></span>;
}