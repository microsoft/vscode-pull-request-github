import * as React from 'react';
import { dateFromNow } from '../src/common/utils';
import { Comment } from '../src/common/comment';
import { getStatus } from './pullRequestOverviewRenderer';
import { PullRequest } from './cache';
import md from './mdRenderer';
import Context from './actions';

export const Overview = (pr: PullRequest) =>
	<>
		<Details {...pr} />
		<Timeline events={pr.events} />
		<hr/>
	</>;

const Avatar = ({ for: author }: { for: PullRequest['author'] }) =>
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
	const pr = useContext(Context);
	console.log('pr=', pr);
	if (!pr) { return; }
	if (pr.pr.isCurrentlyCheckedOut) {
		return <>
			<button aria-live='polite' className='checkedOut' disabled>Checked Out</button>
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

const commitIconSvg = require('../resources/icons/commit_icon.svg');
// const mergeIconSvg = require('../resources/icons/merge_icon.svg');
// const editIcon = require('../resources/icons/edit.svg');
// const deleteIcon = require('../resources/icons/delete.svg');
// const checkIcon = require('../resources/icons/check.svg');
// const dotIcon = require('../resources/icons/dot.svg');

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
import { useContext } from 'react';

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

const CommentEventView = (event: CommentEvent) => <h1>Comment: {event.id}</h1>;
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

const CommentView = ({ user, htmlUrl, createdAt, bodyHTML, body }: Comment) =>
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