/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import React, { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { IComment } from '../../src/common/comment';
import { CommentEvent, EventType, ReviewEvent } from '../../src/common/timelineEvent';
import { GithubItemStateEnum } from '../../src/github/interface';
import { PullRequest, ReviewType } from '../../src/github/views';
import { ariaAnnouncementForReview } from '../common/aria';
import PullRequestContext from '../common/context';
import emitter from '../common/events';
import { useStateProp } from '../common/hooks';
import { ContextDropdown } from './contextDropdown';
import { deleteIcon, editIcon, quoteIcon } from './icon';
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

	const ariaAnnouncement = ((comment as CommentEvent | ReviewEvent).event === EventType.Commented || (comment as CommentEvent | ReviewEvent).event === EventType.Reviewed)
		? ariaAnnouncementForReview(comment as (CommentEvent | ReviewEvent)) : undefined;

	return (
		<CommentBox
			for={comment}
			onMouseEnter={() => setShowActionBar(true)}
			onMouseLeave={() => setShowActionBar(false)}
			onFocus={() => setShowActionBar(true)}
		>
			{ariaAnnouncement ? <div role='alert' aria-label={ariaAnnouncement} /> : null}
			<div className="action-bar comment-actions" style={{ display: showActionBar ? 'flex' : 'none' }}>
				<button
					title="Quote reply"
					className="icon-button"
					onClick={() => emitter.emit('quoteReply', bodyMd)}
				>
					{quoteIcon}
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
				specialDisplayBodyPostfix={(comment as IComment).specialDisplayBodyPostfix}
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

function isIComment(comment: any): comment is IComment {
	return comment && typeof comment === 'object' &&
		typeof comment.body === 'string' && typeof comment.diffHunk === 'string';
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
	const isDraft = (isIComment(comment) && comment.isDraft) ?? (isReviewEvent(comment) && (comment.state?.toLocaleUpperCase() === 'PENDING'));
	const author = ('user' in comment) ? comment.user! : (comment as PullRequest).author!;
	const createdAt = ('createdAt' in comment) ? comment.createdAt : (comment as ReviewEvent).submittedAt;

	return (
		<div className="comment-container comment review-comment" {...{ onFocus, onMouseEnter, onMouseLeave }}>
			<div className="review-comment-container">
				<h3 className={`review-comment-header${(isReviewEvent(comment) && comment.comments.length > 0) ? '' : ' no-details'}`}>
					<Spaced>
						<Avatar for={author} />
						<AuthorLink for={author} />
						{isReviewEvent(comment) ? association(comment) : null}


						{createdAt ? (
							<>
								{(isReviewEvent(comment) && comment.state) ? reviewDescriptor(comment.state) : 'commented'}
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
				</h3>
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
	allowEmpty: boolean;
	specialDisplayBodyPostfix?: string;
}

export const CommentBody = ({ comment, bodyHTML, body, canApplyPatch, allowEmpty, specialDisplayBodyPostfix }: Embodied) => {
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
			{specialDisplayBodyPostfix ? <br /> : null}
			{specialDisplayBodyPostfix ? <em>{specialDisplayBodyPostfix}</em> : null}
			<CommentReactions reactions={comment?.reactions} />
		</div>
	);
};

type CommentReactionsProps = {
	reactions?: { label: string; count: number; reactors: readonly string[] }[];
};

const CommentReactions = ({ reactions }: CommentReactionsProps) => {
	if (!Array.isArray(reactions) || reactions.length === 0) return null;
	const filtered = reactions.filter(r => r.count > 0);
	if (filtered.length === 0) return null;
	return (
		<div className="comment-reactions" style={{ marginTop: 6 }}>
			{filtered.map((reaction, idx) => {
				const maxReactors = 10;
				const reactors = reaction.reactors || [];
				const displayReactors = reactors.slice(0, maxReactors);
				const moreCount = reactors.length > maxReactors ? reactors.length - maxReactors : 0;
				let title: string = '';
				if (displayReactors.length > 0) {
					if (moreCount > 0) {
						title = `${joinWithAnd(displayReactors)} and ${moreCount} more reacted with ${reaction.label}`;
					} else {
						title = `${joinWithAnd(displayReactors)} reacted with ${reaction.label}`;
					}
				}
				return (
					<div
						key={reaction.label + idx}
						title={title}
					>
						<span className="reaction-label">{reaction.label}</span>{nbsp}{reaction.count > 1 ? <span className="reaction-count">{reaction.count}</span> : null}
					</div>
				);
			})}
		</div>
	);
};

export function AddComment({
	pendingCommentText,
	isCopilotOnMyBehalf,
	state,
	hasWritePermission,
	isIssue,
	isAuthor,
	continueOnGitHub,
	currentUserReviewState,
	lastReviewType,
	busy,
}: PullRequest) {
	const { updatePR, requestChanges, approve, close, openOnGitHub, submit } = useContext(PullRequestContext);
	const [isBusy, setBusy] = useState(false);
	const form = useRef<HTMLFormElement>();
	const textareaRef = useRef<HTMLTextAreaElement>();

	emitter.addListener('quoteReply', (message: string) => {
		const quoted = message.replace(/\n/g, '\n> ');
		updatePR({ pendingCommentText: `> ${quoted} \n\n` });
		textareaRef.current?.scrollIntoView();
		textareaRef.current?.focus();
	});

	const closeButton = e => {
		e.preventDefault();
		const { value } = textareaRef.current!;
		close(value);
	};

	let currentSelection: ReviewType = lastReviewType ?? (currentUserReviewState === 'APPROVED' ? ReviewType.Approve : (currentUserReviewState === 'CHANGES_REQUESTED' ? ReviewType.RequestChanges : ReviewType.Comment));

	async function submitAction(action: ReviewType): Promise<void> {
		const { value } = textareaRef.current!;
		if (continueOnGitHub && action !== ReviewType.Comment) {
			await openOnGitHub();
			return;
		}
		setBusy(true);
		switch (action) {
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
	}

	const onKeyDown = useCallback(
		e => {
			if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
				submitAction(currentSelection);
			}
		},
		[submit],
	);

	async function defaultSubmitAction(): Promise<void> {
		await submitAction(currentSelection);
	}

	const availableActions: { [key in ReviewType]?: string } = isAuthor
		? { [ReviewType.Comment]: 'Comment' }
		: continueOnGitHub
			? {
				[ReviewType.Comment]: 'Comment',
				[ReviewType.Approve]: 'Approve on github.com',
				[ReviewType.RequestChanges]: 'Request changes on github.com',
			}
			: commentMethods(isIssue);

	return (
		<form id="comment-form" ref={form as React.MutableRefObject<HTMLFormElement>} className="comment-form main-comment-form" onSubmit={() => submit(textareaRef.current?.value ?? '')}>
			<textarea
				id="comment-textarea"
				name="body"
				ref={textareaRef as React.MutableRefObject<HTMLTextAreaElement>}
				onInput={({ target }) => updatePR({ pendingCommentText: (target as any).value })}
				onKeyDown={onKeyDown}
				value={pendingCommentText}
				placeholder="Leave a comment"
				onClick={() => {
					if (!pendingCommentText && isCopilotOnMyBehalf && !textareaRef.current?.textContent) {
						textareaRef.current!.textContent = '@copilot ';
						textareaRef.current!.setSelectionRange(9, 9);
					}
				}}
			/>
			<div className="form-actions">
				{(hasWritePermission || isAuthor) ? (
					<button
						id="close"
						className="secondary"
						disabled={isBusy || state !== GithubItemStateEnum.Open}
						onClick={closeButton}
						data-command="close"
					>
						{isIssue ? 'Close Issue' : 'Close Pull Request'}
					</button>
				) : null}


				<ContextDropdown
					optionsContext={() => makeCommentMenuContext(availableActions, pendingCommentText)}
					defaultAction={defaultSubmitAction}
					defaultOptionLabel={() => availableActions[currentSelection]!}
					defaultOptionValue={() => currentSelection}
					allOptions={() => {
						const actions: { label: string; value: string; action: (event: React.MouseEvent<HTMLButtonElement, MouseEvent>) => void }[] = [];
						if (availableActions.approve) {
							actions.push({ label: availableActions[ReviewType.Approve]!, value: ReviewType.Approve, action: () => submitAction(ReviewType.Approve) });
						}
						if (availableActions.comment) {
							actions.push({ label: availableActions[ReviewType.Comment]!, value: ReviewType.Comment, action: () => submitAction(ReviewType.Comment) });
						}
						if (availableActions.requestChanges) {
							actions.push({ label: availableActions[ReviewType.RequestChanges]!, value: ReviewType.RequestChanges, action: () => submitAction(ReviewType.RequestChanges) });
						}
						return actions;
					}}
					optionsTitle='Submit pull request review'
					disabled={isBusy || busy}
					hasSingleAction={Object.keys(availableActions).length === 1}
					spreadable={true}
				/>
			</div>
		</form>
	);
}

function commentMethods(isIssue: boolean) {
	return isIssue ? ISSUE_COMMENT_METHODS : COMMENT_METHODS;
}

const ISSUE_COMMENT_METHODS = {
	comment: 'Comment',
};

const COMMENT_METHODS = {
	...ISSUE_COMMENT_METHODS,
	approve: 'Approve',
	requestChanges: 'Request Changes',
};

const makeCommentMenuContext = (availableActions: { comment?: string, approve?: string, requestChanges?: string }, pendingCommentText: string | undefined) => {
	const createMenuContexts = {
		'preventDefaultContextMenuItems': true,
		'github:reviewCommentMenu': true,
	};
	if (availableActions.approve) {
		if (availableActions.approve === COMMENT_METHODS.approve) {
			createMenuContexts['github:reviewCommentApprove'] = true;
		} else {
			createMenuContexts['github:reviewCommentApproveOnDotCom'] = true;
		}
	}
	if (availableActions.comment) {
		createMenuContexts['github:reviewCommentComment'] = true;
	}
	if (availableActions.requestChanges) {
		if (availableActions.requestChanges === COMMENT_METHODS.requestChanges) {
			createMenuContexts['github:reviewCommentRequestChanges'] = true;
		} else {
			createMenuContexts['github:reviewCommentRequestChangesOnDotCom'] = true;
		}
	}
	createMenuContexts['body'] = pendingCommentText ?? '';
	const stringified = JSON.stringify(createMenuContexts);
	return stringified;
};

export const AddCommentSimple = (pr: PullRequest) => {
	const { updatePR, requestChanges, approve, submit, openOnGitHub } = useContext(PullRequestContext);
	const [isBusy, setBusy] = useState(false);
	const textareaRef = useRef<HTMLTextAreaElement>();
	let currentSelection: ReviewType = pr.lastReviewType ?? (pr.currentUserReviewState === 'APPROVED' ? ReviewType.Approve : (pr.currentUserReviewState === 'CHANGES_REQUESTED' ? ReviewType.RequestChanges : ReviewType.Comment));

	async function submitAction(action: ReviewType): Promise<void> {
		const { value } = textareaRef.current!;
		if (pr.continueOnGitHub && action !== ReviewType.Comment) {
			await openOnGitHub();
			return;
		}
		setBusy(true);
		switch (action) {
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
	}

	async function defaultSubmitAction(): Promise<void> {
		await submitAction(currentSelection);
	}

	const onChangeTextarea = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
		updatePR({ pendingCommentText: e.target.value });
	};

	const onKeyDown = useCallback(
		e => {
			if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {

				e.preventDefault();
				defaultSubmitAction();
			}
		},
		[submitAction],
	);

	const availableActions: { comment?: string, approve?: string, requestChanges?: string } = pr.isAuthor
		? { comment: 'Comment' }
		: pr.continueOnGitHub
			? {
				comment: 'Comment',
				approve: 'Approve on github.com',
				requestChanges: 'Request changes on github.com',
			}
			: commentMethods(pr.isIssue);

	return (
		<span className="comment-form">
			<textarea
				id="comment-textarea"
				name="body"
				placeholder="Leave a comment"
				ref={textareaRef as React.MutableRefObject<HTMLTextAreaElement>}
				value={pr.pendingCommentText ?? ''}
				onChange={onChangeTextarea}
				onKeyDown={onKeyDown}
				disabled={isBusy || pr.busy}
			/>
			<div className='comment-button'>
				<ContextDropdown
					optionsContext={() => makeCommentMenuContext(availableActions, pr.pendingCommentText)}
					defaultAction={defaultSubmitAction}
					defaultOptionLabel={() => availableActions[currentSelection]!}
					defaultOptionValue={() => currentSelection}
					allOptions={() => {
						const actions: { label: string; value: string; action: (event: React.MouseEvent<HTMLButtonElement, MouseEvent>) => void }[] = [];
						if (availableActions.approve) {
							actions.push({ label: availableActions[ReviewType.Approve]!, value: ReviewType.Approve, action: () => submitAction(ReviewType.Approve) });
						}
						if (availableActions.comment) {
							actions.push({ label: availableActions[ReviewType.Comment]!, value: ReviewType.Comment, action: () => submitAction(ReviewType.Comment) });
						}
						if (availableActions.requestChanges) {
							actions.push({ label: availableActions[ReviewType.RequestChanges]!, value: ReviewType.RequestChanges, action: () => submitAction(ReviewType.RequestChanges) });
						}
						return actions;
					}}
					optionsTitle='Submit pull request review'
					disabled={isBusy || pr.busy}
					hasSingleAction={Object.keys(availableActions).length === 1}
					spreadable={true}
				/>
			</div>
		</span>
	);
};

function joinWithAnd(arr: string[]): string {
	if (arr.length === 0) return '';
	if (arr.length === 1) return arr[0];
	if (arr.length === 2) return `${arr[0]} and ${arr[1]}`;
	return `${arr.slice(0, -1).join(', ')} and ${arr[arr.length - 1]}`;
}
