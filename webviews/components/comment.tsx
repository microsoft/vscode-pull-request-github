/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import React, { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { IComment } from '../../src/common/comment';
import { GithubItemStateEnum } from '../../src/github/interface';
import { PullRequest, ReviewType } from '../common/cache';
import PullRequestContext from '../common/context';
import emitter from '../common/events';
import { useStateProp } from '../common/hooks';
import { Dropdown } from './dropdown';
import { commentIcon, deleteIcon, editIcon } from './icon';
import { nbsp, Spaced } from './space';
import { Timestamp } from './timestamp';
import { AuthorLink, Avatar } from './user';

export type Props = Partial<IComment & PullRequest> & {
	headerInEditMode?: boolean;
	isPRDescription?: boolean;
};

export function CommentView(comment: Props) {
	const { id, pullRequestReviewId, canEdit, canDelete, bodyHTML, body, isPRDescription } = comment;
	const [bodyMd, setBodyMd] = useStateProp(body);
	const [bodyHTMLState, setBodyHtml] = useStateProp(bodyHTML);
	const { deleteComment, editComment, setDescription, pr } = useContext(PullRequestContext);
	const currentDraft = pr.pendingCommentDrafts && pr.pendingCommentDrafts[id];
	const [inEditMode, setEditMode] = useState(!!currentDraft);
	const [showActionBar, setShowActionBar] = useState(false);

	if (inEditMode) {
		return React.cloneElement(comment.headerInEditMode ? <CommentBox for={comment} /> : <></>, {}, [
			<EditComment
				id={id}
				key={`editComment${id}`}
				body={currentDraft || bodyMd}
				onCancel={() => {
					if (pr.pendingCommentDrafts) {
						delete pr.pendingCommentDrafts[id];
					}
					setEditMode(false);
				}}
				onSave={async text => {
					try {
						const result = isPRDescription
							? await setDescription(text)
							: await editComment({ comment: comment as IComment, text });

						setBodyHtml(result.bodyHTML);
						setBodyMd(text);
					} finally {
						setEditMode(false);
					}
				}}
			/>,
		]);
	}

	return (
		<CommentBox
			for={comment}
			onMouseEnter={() => setShowActionBar(true)}
			onMouseLeave={() => setShowActionBar(false)}
			onFocus={() => setShowActionBar(true)}
		>
			<div className="action-bar comment-actions" style={{ display: showActionBar ? 'flex' : 'none' }}>
				<button
					title="Quote reply"
					className="icon-button"
					onClick={() => emitter.emit('quoteReply', bodyMd)}
				>
					{commentIcon}
				</button>
				{canEdit ? (
					<button title="Edit comment" className="icon-button" onClick={() => setEditMode(true)}>
						{editIcon}
					</button>
				) : null}
				{canDelete ? (
					<button
						title="Delete comment"
						className="icon-button"
						onClick={() => deleteComment({ id, pullRequestReviewId })}
					>
						{deleteIcon}
					</button>
				) : null}
			</div>
			<CommentBody
				comment={comment as IComment}
				bodyHTML={bodyHTMLState}
				body={bodyMd}
				canApplyPatch={pr.isCurrentlyCheckedOut}
			/>
		</CommentBox>
	);
}

type CommentBoxProps = {
	for: Partial<IComment & PullRequest>;
	header?: React.ReactChild;
	onFocus?: any;
	onMouseEnter?: any;
	onMouseLeave?: any;
	children?: any;
};

function CommentBox({ for: comment, onFocus, onMouseEnter, onMouseLeave, children }: CommentBoxProps) {
	const { user, author, createdAt, htmlUrl, isDraft } = comment;
	return (
		<div className="comment-container comment review-comment" {...{ onFocus, onMouseEnter, onMouseLeave }}>
			<div className="review-comment-container">
				<div className="review-comment-header">
					<Spaced>
						<Avatar for={user || author} />
						<AuthorLink for={user || author} />
						{createdAt ? (
							<>
								commented{nbsp}
								<Timestamp href={htmlUrl} date={createdAt} />
							</>
						) : (
							<em>pending</em>
						)}
						{isDraft ? (
							<>
								<span className="pending-label">Pending</span>
							</>
						) : null}
					</Spaced>
				</div>
				{children}
			</div>
		</div>
	);
}

type FormInputSet = {
	[name: string]: HTMLInputElement | HTMLTextAreaElement;
};

type EditCommentProps = {
	id: number;
	body: string;
	onCancel: () => void;
	onSave: (body: string) => Promise<any>;
};

function EditComment({ id, body, onCancel, onSave }: EditCommentProps) {
	const { updateDraft } = useContext(PullRequestContext);
	const draftComment = useRef<{ body: string; dirty: boolean }>({ body, dirty: false });
	const form = useRef<HTMLFormElement>();

	useEffect(() => {
		const interval = setInterval(() => {
			if (draftComment.current.dirty) {
				updateDraft(id, draftComment.current.body);
				draftComment.current.dirty = false;
			}
		}, 500);
		return () => clearInterval(interval);
	}, [draftComment]);

	const submit = useCallback(async () => {
		const { markdown, submitButton }: FormInputSet = form.current;
		submitButton.disabled = true;
		try {
			await onSave(markdown.value);
		} finally {
			submitButton.disabled = false;
		}
	}, [form, onSave]);

	const onSubmit = useCallback(
		event => {
			event.preventDefault();
			submit();
		},
		[submit],
	);

	const onKeyDown = useCallback(
		e => {
			if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
				e.preventDefault();
				submit();
			}
		},
		[submit],
	);

	const onInput = useCallback(
		e => {
			draftComment.current.body = (e.target as any).value;
			draftComment.current.dirty = true;
		},
		[draftComment],
	);

	return (
		<form ref={form} onSubmit={onSubmit}>
			<textarea name="markdown" defaultValue={body} onKeyDown={onKeyDown} onInput={onInput} />
			<div className="form-actions">
				<button className="secondary" onClick={onCancel}>
					Cancel
				</button>
				<input type="submit" name="submitButton" value="Save" />
			</div>
		</form>
	);
}

export interface Embodied {
	comment?: IComment;
	bodyHTML?: string;
	body?: string;
	canApplyPatch: boolean;
}

export const CommentBody = ({ comment, bodyHTML, body, canApplyPatch }: Embodied) => {
	if (!body && !bodyHTML) {
		return (
			<div className="comment-body">
				<em>No description provided.</em>
			</div>
		);
	}

	const { applyPatch } = useContext(PullRequestContext);
	const renderedBody = <div dangerouslySetInnerHTML={{ __html: bodyHTML }} />;

	const containsSuggestion = (body || bodyHTML).indexOf('```diff') > -1;
	const applyPatchButton =
		containsSuggestion && canApplyPatch ? <button onClick={() => applyPatch(comment)}>Apply Patch</button> : <></>;

	return (
		<div className="comment-body">
			{renderedBody}
			{applyPatchButton}
		</div>
	);
};

export function AddComment({
	pendingCommentText,
	state,
	hasWritePermission,
	isIssue,
	isAuthor,
	continueOnGitHub,
	currentUserReviewState,
}: PullRequest) {
	const { updatePR, comment, requestChanges, approve, close, openOnGitHub } = useContext(PullRequestContext);
	const [isBusy, setBusy] = useState(false);
	const form = useRef<HTMLFormElement>();
	const textareaRef = useRef<HTMLTextAreaElement>();

	emitter.addListener('quoteReply', (message: string) => {
		const quoted = message.replace(/\n\n/g, '\n\n> ');
		updatePR({ pendingCommentText: `> ${quoted} \n\n` });
		textareaRef.current.scrollIntoView();
		textareaRef.current.focus();
	});

	const submit = useCallback(
		async (command: (body: string) => Promise<any> = comment) => {
			try {
				setBusy(true);
				const { body }: FormInputSet = form.current;
				if (continueOnGitHub && command !== comment) {
					await openOnGitHub();
				} else {
					await command(body.value);
					updatePR({ pendingCommentText: '' });
				}
			} finally {
				setBusy(false);
			}
		},
		[comment, updatePR, setBusy],
	);

	const onSubmit = useCallback(
		e => {
			e.preventDefault();
			submit();
		},
		[submit],
	);

	const onKeyDown = useCallback(
		e => {
			if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
				submit();
			}
		},
		[submit],
	);

	const onClick = useCallback(
		e => {
			e.preventDefault();
			const { command } = e.target.dataset;
			submit({ approve, requestChanges, close }[command]);
		},
		[submit, approve, requestChanges, close],
	);

	return (
		<form id="comment-form" ref={form} className="comment-form main-comment-form" onSubmit={onSubmit}>
			<textarea
				id="comment-textarea"
				name="body"
				ref={textareaRef}
				onInput={({ target }) => updatePR({ pendingCommentText: (target as any).value })}
				onKeyDown={onKeyDown}
				value={pendingCommentText}
				placeholder="Leave a comment"
			/>
			<div className="form-actions">
				{(hasWritePermission || isAuthor) && !isIssue ? (
					<button
						id="close"
						className="secondary"
						disabled={isBusy || state !== GithubItemStateEnum.Open}
						onClick={onClick}
						data-command="close"
					>
						Close Pull Request
					</button>
				) : null}
				{!isIssue && !isAuthor ? (
					<button
						id="request-changes"
						disabled={isBusy || !pendingCommentText}
						className="secondary"
						onClick={onClick}
						data-command="requestChanges"
					>
						{continueOnGitHub ? 'Request changes on github.com' : 'Request Changes'}
					</button>
				) : null}
				{!isIssue && !isAuthor ? (
					<button
						id="approve"
						className="secondary"
						disabled={isBusy || currentUserReviewState === 'APPROVED'}
						onClick={onClick}
						data-command="approve"
					>
						{continueOnGitHub ? 'Approve on github.com' : 'Approve'}
					</button>
				) : null}
				<input
					id="reply"
					value="Comment"
					type="submit"
					className="secondary"
					disabled={isBusy || !pendingCommentText}
				/>
			</div>
		</form>
	);
}

const COMMENT_METHODS = {
	comment: 'Comment and Submit',
	approve: 'Approve and Submit',
	requestChanges: 'Request Changes and Submit',
};

export const AddCommentSimple = (pr: PullRequest) => {
	const { updatePR, requestChanges, approve, submit, openOnGitHub } = useContext(PullRequestContext);
	const textareaRef = useRef<HTMLTextAreaElement>();

	async function submitAction(selected: string): Promise<void> {
		const { value } = textareaRef.current;
		if (pr.continueOnGitHub && selected !== ReviewType.Comment) {
			await openOnGitHub();
			return;
		}

		switch (selected) {
			case ReviewType.RequestChanges:
				await requestChanges(value);
				break;
			case ReviewType.Approve:
				await approve(value);
				break;
			default:
				await submit(value);
		}
		updatePR({ pendingCommentText: '', pendingReviewType: undefined });
	}

	const onChangeTextarea = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
		updatePR({ pendingCommentText: e.target.value });
	};

	const availableActions = pr.isAuthor
		? { comment: 'Comment and Submit' }
		: pr.continueOnGitHub
			? {
				comment: 'Comment and Submit',
				approve: 'Approve on github.com',
				requestChanges: 'Request changes on github.com',
			}
			: COMMENT_METHODS;

	return (
		<span className="comment-form">
			<textarea
				id="comment-textarea"
				name="body"
				placeholder="Leave a comment"
				ref={textareaRef}
				value={pr.pendingCommentText}
				onChange={onChangeTextarea}
			/>
			<Dropdown options={availableActions} defaultOption="comment" submitAction={submitAction} />
		</span>
	);
};
