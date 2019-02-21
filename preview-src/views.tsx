import * as React from 'react';
import { dateFromNow } from '../src/common/utils';
import { getStatus } from './pullRequestOverviewRenderer';
import { PullRequest } from './cache';
import md from './mdRenderer';

export const Overview = (pr: PullRequest) =>
	<>
		<Details {...pr} />
		<hr/>
	</>;

const Avatar = ({ for: author }: { for: PullRequest['author'] }) =>
	<img className='avatar' src={author.avatarUrl} alt='' />;

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

// const commentBody = document.createElement('div');
// commentBody.className = 'comment-body';
// commentBody.innerHTML = pr.bodyHTML ?
// 	pr.bodyHTML :
// 	pr.body
// 		? md.render(emoji.emojify(pr.body))
// 		: '<p><i>No description provided.</i></p>';
