import * as React from 'react';
import { dateFromNow } from '../src/common/utils';
import { Comment } from '../src/common/comment';
import { getStatus } from './pullRequestOverviewRenderer';
import { PullRequest } from './cache';
import md from './mdRenderer';
import PullRequestContext, { PRContext } from './actions';

const commitIconSvg = require('../resources/icons/commit_icon.svg');
const mergeIconSvg = require('../resources/icons/merge_icon.svg');
const editIcon = require('../resources/icons/edit.svg');
const checkIcon = require('../resources/icons/check.svg');

const plusIcon = require('../resources/icons/plus.svg');
const deleteIcon = require('../resources/icons/delete.svg');

const pendingIcon = require('../resources/icons/dot.svg');
const commentIcon = require('../resources/icons/comment.svg');
const diffIcon = require('../resources/icons/diff.svg');

export const Overview = (pr: PullRequest) =>
	<>
		<Details {...pr} />
		<Timeline events={pr.events} />
		<StatusChecks {...pr} />
		<hr/>
	</>;

const Avatar = ({ for: author }: { for: Partial<PullRequest['author']> }) =>
	<a className='avatar-link' href={author.url}>
		<img className='avatar' src={author.avatarUrl} alt='' />
	</a>;

const AuthorLink = ({ for: author, text=author.login }: { for: PullRequest['author'], text?: string }) =>
	<a href={author.url}>{text}</a>;

const nbsp = String.fromCharCode(0xa0);
const Spaced = ({ children }) => {
	const count = React.Children.count(children);
	return React.createElement(React.Fragment, {
		children: React.Children.map(children, (c, i) =>
			typeof c === 'string'
				? `${i > 0 ? nbsp : ''}${c}${i < count - 1 ? nbsp : ''}`
				: c
		)
	});
};

export const Details = (pr: PullRequest) =>
	<div className='details'>
		<Header {...pr} />
		<Description {...pr} />
	</div>;

export const Header = ({ state, title, head, base, url, createdAt, author, isCurrentlyCheckedOut }: PullRequest) =>
	<>
		<div className='overview-title'>
			<h2>{title}</h2>
			<div className='button-group'>
				<CheckoutButtons />
				<button>Refresh</button>
			</div>
		</div>
		<div className='subtitle'>
			<div id='status'>{getStatus(state)}</div>
			<Avatar for={author} />
			<span className='author'>
				<Spaced>
					<AuthorLink for={author} /> wants to merge changes
					from <code>{head}</code>
					to <code>{base}</code>
				</Spaced>.
			</span>
			<span className='created-at'>
				<Spaced>
					Created <Timestamp date={createdAt} href={url} />
				</Spaced>
			</span>
		</div>
	</>;

const CheckoutButtons = () => {
	const ctx = useContext(PullRequestContext);
	if (!ctx) { return; }
	if (ctx.pr.isCurrentlyCheckedOut) {
		return <>
			<button aria-live='polite' className='checkedOut' disabled><Icon src={checkIcon} /> Checked Out</button>
			<button aria-live='polite' onClick={() => pr.exitReviewMode()}>Exit Review Mode</button>
		</>;
	} else {
		return <button aria-live='polite' onClick={() => pr.checkout()}>Checkout</button>;
	}
};

const Timestamp = ({
	date,
	href,
}: {
	date: Date | string,
	href: string
}) => <a href={href} className='timestamp'>{dateFromNow(date)}</a>;

interface Embodied {
	bodyHTML?: string;
	body?: string;
}

const CommentBody = ({ bodyHTML, body }: Embodied) =>
	bodyHTML
	? <div className='comment-body'
		dangerouslySetInnerHTML={ {__html: bodyHTML }} />
	:
	<Markdown className='comment-body' src={body} />;

const Description = (pr: PullRequest) =>
	<div className='description-container'><CommentBody {...pr} /></div>;

const emoji = require('node-emoji');

type MarkdownProps = { src: string } & Record<string, any>;

const Markdown = ({ src, ...others }: MarkdownProps) =>
	<div dangerouslySetInnerHTML={{ __html: md.render(emoji.emojify(src)) }} {...others} />;

import { TimelineEvent, isReviewEvent, isCommitEvent, isCommentEvent, isMergedEvent, isAssignEvent, ReviewEvent, CommitEvent, CommentEvent, MergedEvent, AssignEvent } from '../src/common/timelineEvent';
const Timeline = ({ events }: { events: TimelineEvent[] }) =>
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

const Icon = ({ src }: { src: string }) =>
	<span dangerouslySetInnerHTML={{ __html: src }} />;

const CommitEventView = (event: CommitEvent) =>
	<div className='comment-container commit'>
		<div className='commit-message'>
			<Icon src={commitIconSvg} />
			<div className='avatar-container'>
				<Avatar for={event.author} />
			</div>
			<AuthorLink for={event.author} />
			<div className='message'>{event.message}</div>
		</div>
		<a className='sha' href={event.url}>{event.sha.slice(0, 7)}</a>
	</div>;

const association = ({ authorAssociation }: ReviewEvent,
	format=(assoc: string) => `(${assoc.toLowerCase()})`) =>
	(authorAssociation && authorAssociation !== 'NONE')
		? format(authorAssociation)
		: null;

import { groupBy } from 'lodash';
import { DiffHunk, DiffLine } from '../src/common/diffHunk';
import { useContext, useReducer, useRef, useState } from 'react';
import { PullRequestStateEnum, MergeMethod } from '../src/github/interface';

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

const Diff = ({ hunks, path, outdated=false }: { hunks: DiffHunk[], outdated: boolean, path: string }) =>
	<div className='diff'>
		<div className='diffHeader'>
			<span className={`diffPath ${outdated ? 'outdated' : ''}`}>{path}</span>
		</div>
		{hunks.map(hunk => <Hunk hunk={hunk} />)}
	</div>;

const Hunk = ({ hunk, maxLines=4 }: {hunk: DiffHunk, maxLines?: number }) => <>{
	hunk.diffLines.slice(-maxLines)
		.map(line =>
			<div key={keyForDiffLine(line)} className={`diffLine ${getDiffChangeClass(line.type)}`}>
				<LineNumber num={line.oldLineNumber} />
				<LineNumber num={line.newLineNumber} />
				<span className='lineContent'>{(line as any)._raw}</span>
			</div>)
}</>;

const keyForDiffLine = (diffLine: DiffLine) =>
	`${diffLine.oldLineNumber}->${diffLine.newLineNumber}`;

const LineNumber = ({ num }: { num: number }) =>
	<span className='lineNumber'>{num > 0 ? num : ' '}</span>;
// const ReviewComment = (c: Comment) => {
// 	return <div className='comment-body review-comment-body'>

// 	</div>
// }

const CommentEventView = (event: CommentEvent) => <CommentView {...event} />;
const MergedEventView = (event: MergedEvent) => <h1>Merged: {event.id}</h1>;
const AssignEventView = (event: AssignEvent) => <h1>Assign: {event.id}</h1>;

export enum DiffChangeType {
	Context,
	Add,
	Delete,
	Control
}

export function getDiffChangeType(text: string) {
	let c = text[0];
	switch (c) {
		case ' ': return DiffChangeType.Context;
		case '+': return DiffChangeType.Add;
		case '-': return DiffChangeType.Delete;
		default: return DiffChangeType.Control;
	}
}

const getDiffChangeClass = (type: DiffChangeType) =>
	DiffChangeType[type].toLowerCase();

const CommentView = ({ user, htmlUrl, createdAt, bodyHTML, body }: Partial<Comment>) =>
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

const StatusChecks = (pr: PullRequest) => {
	const { state, status, mergeable } = pr;
	const [showDetails, toggleDetails] = useReducer(show => !show, false);

	return <div id='status-checks'>{
		state === PullRequestStateEnum.Merged
			? 'Pull request successfully merged'
			:
		state === PullRequestStateEnum.Closed
			? 'This pull request is closed'
			:
			<>
				<div className='status-section'>
					<div className='status-item'>
						<StateIcon state={status.state} />
						<div>{getSummaryLabel(status.statuses)}</div>
						<a aria-role='button' onClick={toggleDetails}>{
							showDetails ? 'Hide' : 'Show'
						}</a>
					</div>
					{showDetails ?
						<StatusCheckDetails statuses={status.statuses} />
						: null}
				</div>
				<MergeStatus mergeable={mergeable} />
				{ mergeable ? <Merge {...pr} /> : null}
			</>
	}</div>;
};

const MergeStatus = ({ mergeable }: Pick<PullRequest, 'mergeable'>) =>
	<div className='status-item status-section'>
		<Icon src={mergeable ? checkIcon : deleteIcon} />
		<div>{
			mergeable
				? 'This branch has no conflicts with the base branch'
				: 'This branch has conflicts that must be resolved'
		}</div>
	</div>;

const Merge = (pr: PullRequest) => {
	const select = useRef<HTMLSelectElement>();
	const [ selectedMethod, selectMethod ] = useState<MergeMethod | null>(null);

	if (selectedMethod) {
		return <ConfirmMerge pr={pr} method={selectedMethod} cancel={() => selectMethod(null)} />;
	}

	return <div className='merge-select-container'>
		<button onClick={() => selectMethod(select.current.value as MergeMethod)}>Merge Pull Request</button>
		{nbsp}using method{nbsp}
		<MergeSelect ref={select} {...pr} />
	</div>;
};

function ConfirmMerge({pr, method, cancel}: {pr: PullRequest, method: MergeMethod, cancel: () => void}) {
	const { merge } = useContext(PullRequestContext);

	return <form onSubmit={
		event => {
			event.preventDefault();
			const {title, description}: any = event.target;
			merge({
				title: title.value,
				description: description.value,
				method,
			});
		}
	}>
		<input type='text' name='title' defaultValue={getDefaultTitleText(method, pr)} />
		<textarea name='description' defaultValue={getDefaultDescriptionText(method, pr)} />
		<div className='form-actions'>
			<button className='secondary' onClick={cancel}>Cancel</button>
			<input type='submit' id='confirm-merge' value={MERGE_METHODS[method]} />
		</div>
	</form>;
}

function getDefaultTitleText(mergeMethod: string, pr: PullRequest) {
	switch (mergeMethod) {
		case 'merge':
			return `Merge pull request #${pr.number} from ${pr.head}`;
		case 'squash':
			return pr.title;
		default:
			return '';
	}
}

function getDefaultDescriptionText(mergeMethod: string, pr: PullRequest) {
	return mergeMethod === 'merge' ? pr.title : '';
}

const MERGE_METHODS = {
	merge: 'Create Merge Commit',
	squash: 'Squash and Merge',
	rebase: 'Rebase and Merge',
};

type MergeSelectProps =
	Pick<PullRequest, 'mergeMethodsAvailability'> &
	Pick<PullRequest, 'defaultMergeMethod'>;

const MergeSelect = React.forwardRef<HTMLSelectElement, MergeSelectProps>((
	{ defaultMergeMethod, mergeMethodsAvailability: avail }: MergeSelectProps,
	ref) =>
	<select ref={ref} defaultValue={defaultMergeMethod}>{
		Object.entries(MERGE_METHODS)
			.map(([method, text]) =>
				<option key={method} value={method} disabled={!avail[method]}>
					{text}{!avail[method] ? '(not enabled)' : null}
				</option>
			)
}</select>);

const StatusCheckDetails = ({ statuses }: Partial<PullRequest['status']>) =>
	<div>{
		statuses.map(s =>
			<div key={s.id} className='status-check'>
				<StateIcon state={s.state} />
				<Avatar for={{ avatarUrl: s.avatar_url, url: s.url }} />
				<span className='status-check-detail-text'>{s.context} — {s.description}</span>
				<a href={s.target_url}>Details</a>
			</div>
		)
	}</div>;

function getSummaryLabel(statuses: any[]) {
	const statusTypes = groupBy(statuses, (status: any) => status.state);
	let statusPhrases = [];
	for (let statusType of Object.keys(statusTypes)) {
		const numOfType = statusTypes[statusType].length;
		let statusAdjective = '';

		switch (statusType) {
			case 'success':
				statusAdjective = 'successful';
				break;
			case 'failure':
				statusAdjective = 'failed';
				break;
			default:
				statusAdjective = 'pending';
		}

		const status = numOfType > 1
			? `${numOfType} ${statusAdjective} checks`
			: `${numOfType} ${statusAdjective} check`;

		statusPhrases.push(status);
	}

	console.log('statuses:', statuses);
	console.log('status text:', statusPhrases.join(' and '));
	return statusPhrases.join(' and ');
}

const StateIcon = ({ state }: { state: string }) =>
	<Icon src={
		state === 'success'
			? checkIcon
			:
		state === 'failure'
			? deleteIcon
			:
			pendingIcon
	}/>;