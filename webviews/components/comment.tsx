/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Comment, PullRequestStatus } from 'azure-devops-node-api/interfaces/GitInterfaces';
import * as React from 'react';
import ReactMarkdown from 'react-markdown';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { dracula } from 'react-syntax-highlighter/dist/esm/styles/prism';
import gfm from 'remark-gfm';

import { PullRequest, ReviewType } from '../common/cache';
import PullRequestContext from '../common/context';
import emitter from '../common/events';
import { useStateProp } from '../common/hooks';
import { Dropdown } from './dropdown';
import { commentIcon, editIcon } from './icon';
import { nbsp, Spaced } from './space';
// eslint-disable-next-line import/no-named-as-default
import Timestamp from './timestamp';
import { AuthorLink, Avatar } from './user';

const { useCallback, useContext, useEffect, useRef, useState } = React;
export type Props = Partial<Comment> & {
	headerInEditMode?: boolean;
	isPRDescription?: boolean;
	threadId: number;
	canEdit?: boolean;
	isFirstCommentInThread?: boolean;
	threadStatus?: number;
	changeThreadStatus?: (string) => void;
};

export function CommentView(comment: Props) {
	const { threadId, content, canEdit, isPRDescription, threadStatus, isFirstCommentInThread, changeThreadStatus } = comment;
	const id = threadId * 1000 + comment.id;
	const [bodyMd, setBodyMd] = useStateProp(content);
	const [bodyHTMLState, setBodyHtml] = useStateProp(content);
	const { editComment, setDescription, pr } = useContext(PullRequestContext);
	const currentDraft = pr.pendingCommentDrafts && pr.pendingCommentDrafts[id];
	const [inEditMode, setEditMode] = useState(!!currentDraft);
	const [showActionBar, setShowActionBar] = useState(false);
	const statusProps = !!isFirstCommentInThread
		? { threadStatus: threadStatus, changeThreadStatus: changeThreadStatus }
		: null;

	if (inEditMode) {
		return React.cloneElement(comment.headerInEditMode ? <CommentBox for={comment} /> : <></>, {}, [
			<EditComment
				id={id}
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
							: await editComment({ comment: comment, threadId, text });

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
			{...statusProps}
		>
			{showActionBar ? (
				<div className="action-bar comment-actions">
					<button title="Quote reply" onClick={() => emitter.emit('quoteReply', bodyMd)}>
						{commentIcon}
					</button>
					{canEdit ? (
						<button title="Edit comment" onClick={() => setEditMode(true)}>
							{editIcon}
						</button>
					) : null}
					{/* {canDelete ? <button title='Delete comment' onClick={() => deleteComment({ id, pullRequestReviewId })} >{deleteIcon}</button> : null} */}
				</div>
			) : null}
			<CommentBody
				commentContent={comment.content}
				commentId={comment.id}
				threadId={comment.threadId}
				bodyHTML={bodyHTMLState}
				body={bodyMd}
			/>
		</CommentBox>
	);
}

export const ThreadStatus = {
	'0': 'UNKNOWN',
	'1': 'Active',
	'2': 'Fixed',
	'3': 'WontFix',
	'4': 'Closed',
	// '5': 'ByDesign',
	'6': 'Pending',
};

const ThreadStatusOrder = ['1', '6', '2', '3', '4'];

type CommentBoxProps = {
	for: Partial<Comment>;
	header?: React.ReactChild;
	onMouseEnter?: any;
	onMouseLeave?: any;
	children?: any;
	threadStatus?: number;
	changeThreadStatus?: (string) => void;
};

function CommentBox({ for: comment, onMouseEnter, onMouseLeave, children, threadStatus, changeThreadStatus }: CommentBoxProps) {
	const { author, publishedDate, _links } = comment;
	const htmlUrl = _links.self.href;
	return (
		<div className="comment-container comment review-comment" {...{ onMouseEnter, onMouseLeave }}>
			<div className="review-comment-container">
				<div className="review-comment-header">
					<Spaced>
						<Avatar url={author.profileUrl} avatarUrl={author['_links']?.['avatar']?.['href']} />
						<AuthorLink url={author.profileUrl} text={author.displayName} />
						{publishedDate ? (
							<>
								commented{nbsp}
								<Timestamp href={htmlUrl} date={publishedDate} />
							</>
						) : (
							<em>pending</em>
						)}
						{/* {
						isDraft
							? <>
								<span className='pending-label'>Pending</span>
							</>
							: null
					} */}
						{!!threadStatus ? (
							<select onChange={e => changeThreadStatus(e.target.value)} defaultValue={threadStatus.toString()}>
								{ThreadStatusOrder.map(status => (
									<option key={status} value={status}>
										{ThreadStatus[status]}
									</option>
								))}
							</select>
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
	commentContent: string;
	commentId: number;
	threadId: number;
	bodyHTML?: string;
	body?: string;
}

const renderers = {
	code: ({ language, value }) => {
		return (
			<SyntaxHighlighter
				style={dracula}
				language={language}
				showLineNumbers={true}
				wrapLongLines={true}
				children={value}
			/>
		);
	},
};

export const CommentBody = ({ commentContent, commentId, threadId, bodyHTML, body }: Embodied) => {
	if (!body && !bodyHTML) {
		return (
			<div className="comment-body">
				<em>No description provided.</em>
			</div>
		);
	}

	const { applyPatch } = useContext(PullRequestContext);
	// const renderedBody = <div dangerouslySetInnerHTML={{ __html: bodyHTML }} />;
	const renderedBody = <ReactMarkdown renderers={renderers} plugins={[gfm]} children={body} />;
	const containsSuggestion = (body || bodyHTML).indexOf('```diff') > -1;
	const applyPatchButton = containsSuggestion ? (
		<button onClick={() => applyPatch(commentContent, commentId, threadId)}>Apply Patch</button>
	) : (
		<></>
	);

	return (
		<div className="comment-body">
			{renderedBody}
			{applyPatchButton}
		</div>
	);
};

export type ReplyToThreadProps = {
	onCancel: () => void;
	onSave: (body: string) => Promise<any>;
};

export function ReplyToThread({ onCancel, onSave }: ReplyToThreadProps) {
	const form = useRef<HTMLFormElement>();

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

	return (
		<form ref={form} onSubmit={onSubmit}>
			<textarea name="markdown" onKeyDown={onKeyDown} />
			<div className="form-actions">
				<button className="secondary" onClick={onCancel}>
					Cancel
				</button>
				<input type="submit" name="submitButton" value="Save" />
			</div>
		</form>
	);
}

export function AddComment({ pendingCommentText, state, hasWritePermission, isIssue }: PullRequest) {
	const { updatePR, comment, close } = useContext(PullRequestContext);
	const [isBusy, setBusy] = useState(false);
	const form = useRef<HTMLFormElement>();
	const textareaRef = useRef<HTMLTextAreaElement>();

	emitter.addListener('quoteReply', message => {
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
			submit({ close }[command]);
		},
		[submit, close],
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
				{hasWritePermission && !isIssue ? (
					<button
						id="close"
						className="secondary"
						disabled={isBusy || state !== PullRequestStatus.Active}
						onClick={onClick}
						data-command="close"
					>
						Close Pull Request
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
	comment: 'Comment',
	approve: 'Approve',
	requestChanges: 'Request Changes',
};

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
	};

	const availableActions = pr.isAuthor ? { comment: 'Comment' } : COMMENT_METHODS;

	return (
		<span>
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
