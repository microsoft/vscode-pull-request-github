import * as React from 'react';
import { PullRequest } from './cache';
import { Icon } from './icon';

export const Avatar = ({ for: author }: { for: Partial<PullRequest['author']> }) =>
	<a className='avatar-link' href={author.url}>
		{author.avatarUrl
			? <img className='avatar' src={author.avatarUrl} alt='' />
			: <Icon className='avatar-icon' src={require('../resources/icons/dark/github.svg')} /> }
	</a>;

export const AuthorLink = ({ for: author, text=author.login }: { for: PullRequest['author'], text?: string }) =>
	<a className='author-link' href={author.url}>{text}</a>;
