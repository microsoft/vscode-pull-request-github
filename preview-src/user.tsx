import * as React from 'react';
import { PullRequest } from './cache';

export const Avatar = ({ for: author }: { for: Partial<PullRequest['author']> }) =>
	<a className='avatar-link' href={author.url}>
		<img className='avatar' src={author.avatarUrl} alt='' />
	</a>;

export const AuthorLink = ({ for: author, text=author.login }: { for: PullRequest['author'], text?: string }) =>
	<a href={author.url}>{text}</a>;
