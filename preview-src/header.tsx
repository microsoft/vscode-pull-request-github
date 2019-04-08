import * as React from 'react';
import { useContext } from 'react';

import { PullRequest } from './cache';
import { getStatus } from './pullRequestOverviewRenderer';
import { Avatar, AuthorLink } from './user';
import { Spaced } from './space';
import PullRequestContext from './context';
import { checkIcon } from './icon';
import Timestamp from './timestamp';

export const Header = ({ state, title, number, head, base, url, createdAt, author, }: PullRequest) =>
<>
	<div className='overview-title'>
		<h2>{title} (<a href={url}>#{number}</a>)</h2>
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
	const { pr, exitReviewMode, checkout } = useContext(PullRequestContext);
	if (pr.isCurrentlyCheckedOut) {
		return <>
			<button aria-live='polite' className='checkedOut' disabled>{checkIcon} Checked Out</button>
			<button aria-live='polite' onClick={exitReviewMode}>Exit Review Mode</button>
		</>;
	} else {
		return <button aria-live='polite' onClick={checkout}>Checkout</button>;
	}
};