/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import React, { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { IComment } from '../../src/common/comment';
import { CommentEvent, ReviewEvent } from '../../src/common/timelineEvent';
import { GithubItemStateEnum } from '../../src/github/interface';
import { PullRequest, ReviewType } from '../../src/github/views';
import PullRequestContext from '../common/context';
import emitter from '../common/events';
import { useStateProp } from '../common/hooks';
import { Dropdown } from './dropdown';
import { chevronDownIcon, commentIcon, deleteIcon, editIcon } from './icon';
import { nbsp, Spaced } from './space';
import { Timestamp } from './timestamp';
import { AuthorLink, Avatar } from './user';

export type Props = {
	headerInEditMode?: boolean;
	isPRDescription?: boolean;
	children?: any;
	comment: IComment | ReviewEvent | PullRequest | CommentEvent;
	allowEmpty?: boolean;
};

const association = ({ authorAssociation }: ReviewEvent, format = (assoc: string) => `(${assoc.toLowerCase()})`) =>
	authorAssociation.toLowerCase() === 'user'
		? format('you')
		: authorAssociation && authorAssociation !== 'NONE'
			? format(authorAssociation)
			: null;

export function CommentView(commentProps: Props) {
	const { isPRDescription, children, comment, headerInEditMode } = commentProps;
	const { bodyHTML, body } = comment;
	const id = ('id' in comment) ? comment.id : -1;
	const canEdit = ('canEdit' in comment) ? comment.canEdit : false;
	const canDelete = ('canDelete' in comment) ? comment.canDelete : false;

	const pullRequestReviewId = (comment as IComment).pullRequestReviewId;
	const [bodyMd, setBodyMd] = useStateProp(body);
	const [bodyHTMLState, setBodyHtml] = useStateProp(bodyHTML);
	const { deleteComment, editComment, setDescription, pr } = useContext(PullRequestContext);
	const currentDraft = pr.pendingCommentDrafts && pr.pendingCommentDrafts[id];
	const [inEditMode, setEditMode] = useState(!!currentDraft);
	const [showActionBar, setShowActionBar] = useState(false);

	if (inEditMode) {
		return React.cloneElement(headerInEditMode ? <CommentBox for={comment} /> : <></>, {}, [
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
				allowEmpty={!!commentProps.allowEmpty}
			/>
			{children}
		</CommentBox>
	);
}

type CommentBoxProps = {
	for: IComment | ReviewEvent | PullRequest | CommentEvent;
	header?: React.ReactChild;
	onFocus?: any;
	onMouseEnter?: any;
	onMouseLeave?: any;
	children?: any;
};

function isReviewEvent(comment: IComment | ReviewEvent | PullRequest | CommentEvent): comment is ReviewEvent {
	return (comment as ReviewEvent).authorAssociation !== undefined;
}

const DESCRIPTORS = {
	PENDING: 'will review',
	COMMENTED: 'reviewed',
	CHANGES_REQUESTED: 'requested changes',
	APPROVED: 'approved',
};

const reviewDescriptor = (state: string) => DESCRIPTORS[state] || 'reviewed';

function CommentBox({ for: comment, onFocus, onMouseEnter, onMouseLeave, children }: CommentBoxProps) {
	const htmlUrl = ('htmlUrl' in comment) ? comment.htmlUrl : (comment as PullRequest).url;
	const isDraft = (comment as IComment).isDraft ?? (isReviewEvent(comment) && (comment.state.toLocaleUpperCase() === 'PENDING'));
	const author = ('user' in comment) ? comment.user! : (comment as PullRequest).author!;
	const createdAt = ('createdAt' in comment) ? comment.createdAt : (comment as ReviewEvent).submittedAt;

	return (
		<div className="comment-container comment review-comment" {...{ onFocus, onMouseEnter, onMouseLeave }}>
			<div className="review-comment-container">
				<div className="review-comment-header">
					<Spaced>
						<Avatar for={author} />
						<AuthorLink for={author} />
						{isReviewEvent(comment) ? association(comment) : null}


						{createdAt ? (
							<>
								{isReviewEvent(comment) ? reviewDescriptor(comment.state) : 'commented'}
								{nbsp}
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
		const { markdown, submitButton }: FormInputSet = form.current!;
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
		<form ref={form as React.MutableRefObject<HTMLFormElement>} onSubmit={onSubmit}>
			<textarea name="markdown" defaultValue={body} onKeyDown={onKeyDown} onInput={onInput} />
			<div className="form-actions">
				<button className="secondary" onClick={onCancel}>
					Cancel
				</button>
				<button type="submit" name="submitButton">Save</button>
			</div>
		</form>
	);
}

export interface Embodied {
	comment?: IComment;
	bodyHTML?: string;
	body?: string;
	canApplyPatch: boolean;
	allowEmpty: boolean
}

export const CommentBody = ({ comment, bodyHTML, body, canApplyPatch, allowEmpty }: Embodied) => {
	if (!body && !bodyHTML) {
		if (allowEmpty) {
			return null;
		}
		return (
			<div className="comment-body">
				<em>No description provided.</em>
			</div>
		);
	}

	const { applyPatch } = useContext(PullRequestContext);
	const renderedBody = <div dangerouslySetInnerHTML={{ __html: bodyHTML ?? '' }} />;

	const containsSuggestion = ((body || bodyHTML)?.indexOf('```diff') ?? -1) > -1;
	const applyPatchButton =
		containsSuggestion && canApplyPatch && comment ? <button onClick={() => applyPatch(comment)}>Apply Patch</button> : <></>;

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
		textareaRef.current?.scrollIntoView();
		textareaRef.current?.focus();
	});

	const submit = useCallback(
		async (command: (body: string) => Promise<any> = comment) => {
			try {
				setBusy(true);
				const body: HTMLTextAreaElement | HTMLInputElement | undefined = form.current?.body;
				if (continueOnGitHub && command !== comment) {
					await openOnGitHub();
				} else if (body) {
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
		<form id="comment-form" ref={form as React.MutableRefObject<HTMLFormElement>} className="comment-form main-comment-form" onSubmit={onSubmit}>
			<textarea
				id="comment-textarea"
				name="body"
				ref={textareaRef as React.MutableRefObject<HTMLTextAreaElement>}
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
				<button
					id="reply"
					type="submit"
					disabled={isBusy || !pendingCommentText}
				>Comment</button>
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
	const { updatePR, requestChanges, approve, submit, openOnGitHub } = useContext(PullRequestContext);
	const [isBusy, setBusy] = useState(false);
	const textareaRef = useRef<HTMLTextAreaElement>();
	let currentSelection: string = 'comment';

	async function submitAction(): Promise<void> {
		const { value } = textareaRef.current!;
		if (pr.continueOnGitHub && currentSelection !== ReviewType.Comment) {
			await openOnGitHub();
			return;
		}
		setBusy(true);
		switch (currentSelection) {
			case ReviewType.RequestChanges:
				await requestChanges(value);
				break;
			case ReviewType.Approve:
				await approve(value);
				break;
			default:
				await submit(value);
		}
		setBusy(false);
		updatePR({ pendingCommentText: '', pendingReviewType: undefined });
	}

	const onChangeTextarea = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
		updatePR({ pendingCommentText: e.target.value });
	};

	const onKeyDown = useCallback(
		e => {
			if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {

				e.preventDefault();
				submitAction();
			}
		},
		[submitAction],
	);

	const availableActions: {comment?: string, approve?: string, requestChanges?: string}  = pr.isAuthor
		? { comment: 'Comment' }
		: pr.continueOnGitHub
			? {
				comment: 'Comment',
				approve: 'Approve on github.com',
				requestChanges: 'Request changes on github.com',
			}
			: COMMENT_METHODS;

	const makeCommentMenuContext = () => {
		const createMenuContexts = {
			'preventDefaultContextMenuItems': true,
			'github:reviewCommentMenu': true,
		};
		// TODO: use the "on github" contexts/commands when needed
		if (availableActions.approve) {
			createMenuContexts['github:reviewCommentApprove'] = true;
		}
		if (availableActions.comment) {
			createMenuContexts['github:reviewCommentComment'] = true;
		}
		if (availableActions.requestChanges) {
			createMenuContexts['github:reviewCommentRequestChanges'] = true;
		}
		createMenuContexts['body'] = pr.pendingCommentText;
		const stringified = JSON.stringify(createMenuContexts);
		return stringified;
	};

	return (
		<span className="comment-form">
			<textarea
				id="comment-textarea"
				name="body"
				placeholder="Leave a comment"
				ref={textareaRef as React.MutableRefObject<HTMLTextAreaElement>}
				value={pr.pendingCommentText}
				onChange={onChangeTextarea}
				onKeyDown={onKeyDown}
				disabled={isBusy || pr.busy}
			/>
			<div className='comment-button'>
				<button className='split-left' disabled={isBusy || pr.busy} onClick={submitAction} value={currentSelection}
					title={currentSelection}>
					{availableActions[currentSelection]}
				</button>
				<div className='split'></div>
				<button className='split-right' title='Submit pull request' disabled={isBusy || pr.busy} onClick={(e) => {
					e.preventDefault();
					const rect = (e.target as HTMLElement).getBoundingClientRect();
					const x = rect.left;
					const y = rect.bottom;
					e.target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: x, clientY: y }));
					e.stopPropagation();
				}} data-vscode-context={makeCommentMenuContext()}>
					{chevronDownIcon}
				</button>
			</div>
		</span>
	);
};
