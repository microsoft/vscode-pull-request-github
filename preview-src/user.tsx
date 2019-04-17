import * as React from 'react';
import { PullRequest } from './cache';
import { Resource } from '../src/common/resources';

export const Avatar = ({ for: author }: { for: Partial<PullRequest['author']> }) =>
	<a className='avatar-link' href={author.url}>
		<img className='avatar' src={author.avatarUrl ? author.avatarUrl : Resource.icons.light.Avatar} alt='' />
	</a>;

export const AuthorLink = ({ for: author, text=author.login }: { for: PullRequest['author'], text?: string }) =>
	<a href={author.url}>{text}</a>;
