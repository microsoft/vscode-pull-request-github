import * as React from 'react';
import { dateFromNow } from '../src/common/utils';
import { getStatus } from './pullRequestOverviewRenderer';
import { PullRequest } from './cache';
import md from './mdRenderer';

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

const Spaced = ({ children }) => {
	const count = React.Children.count(children);
	return React.createElement(React.Fragment, {
		children: React.Children.map(children, (c, i) =>
			typeof c === 'string'
				? `${i > 0 ? ' ' : ''}${c}${i < count - 1 ? ' ' : ''}`
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
				{
					isCurrentlyCheckedOut
						? <button aria-live='polite'>Exit Review Mode</button>
						: <button aria-live='polite'>Checkout</button>
				}
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
					Created
					<a href={url} className='timestamp'>{dateFromNow(createdAt)}</a>
				</Spaced>
			</span>
		</div>
	</>;

const Description = ({ bodyHTML, body }: PullRequest) =>
	<div className='description-container'>{
		bodyHTML
			? <div className='comment-body'
				dangerouslySetInnerHTML={ {__html: bodyHTML }} />
			:
			<Markdown className='comment-body' src={body} />
	}</div>;

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
				? <Commit key={event.id} {...event} />
				:
			isReviewEvent(event)
				? <Review key={event.id} {...event} />
				:
			isCommentEvent(event)
				? <Comment key={event.id} {...event} />
				:
			isMergedEvent(event)
				? <Merged key={event.id} {...event} />
				:
			isAssignEvent(event)
				? <Assign key={event.id} {...event} />
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

const Commit = (event: CommitEvent) =>
	<div className='comment-container commit'>
		<div className='commit-message'>
			<Icon src={commitIconSvg} />
			<div className='avatar-container'>
				<Avatar for={event.author} />
			</div>
			<AuthorLink for={event.author} />
			<div className='message'>{event.message}</div>
		</div>
		<a className='sha' href={event.url}>{event.sha}</a>
	</div>;

const Review = (event: ReviewEvent) => <h1>Review: {event.id}</h1>;
const Comment = (event: CommentEvent) => <h1>Comment: {event.id}</h1>;
const Merged = (event: MergedEvent) => <h1>Merged: {event.id}</h1>;
const Assign = (event: AssignEvent) => <h1>Assign: {event.id}</h1>;
