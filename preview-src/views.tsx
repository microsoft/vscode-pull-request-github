import * as React from 'react';
import { dateFromNow } from '../src/common/utils';
import { getStatus } from './pullRequestOverviewRenderer';
import { PullRequest } from './cache';

export const Overview = (pr: PullRequest) =>
	<>
		<Title {...pr} />
		<hr/>
	</>;

const Avatar = ({ for: author }: { for: PullRequest['author'] }) =>
	<img className='avatar' src={author.avatarUrl} alt='' />;

const AuthorLink = ({ for: author, text=author.login }: { for: PullRequest['author'], text?: string }) =>
	<a href={author.url}>{text}</a>;

const spaced = (...things: any[]) => {
	const out = new Array(things.length * 2 - 1).fill(' ');
	let i = things.length; while (i --> 0) {
		out[i * 2] = things[i];
	}
	return out;
};

export const Title = ({ state, title, head, base, url, createdAt, author, isCurrentlyCheckedOut }: PullRequest) =>
	author &&
	<div className='details'>
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
			<span className='author'>{spaced(
				<AuthorLink for={author} />,
				'wants to merge changes from',
				<code>{head}</code>,
				'to',
				<code>{base}</code>
			)}.</span>
			<span className='created-at'>Created
				<a href={url} className='timestamp'> {dateFromNow(createdAt)} </a></span>
		</div>
	</div>;