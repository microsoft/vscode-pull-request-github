/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import { IAccount, IActor, ITeam, reviewerLabel } from '../../src/github/interface';
import { Icon } from './icon';

export const Avatar = ({ for: author }: { for: Partial<IAccount> }) => (
	<>
		{author.avatarUrl ? (
			<img className="avatar" src={author.avatarUrl} alt="" role="presentation" />
		) : (
			<Icon className="avatar-icon" src={require('../../resources/icons/dark/github.svg')} />
		)}
	</>
);

export const AuthorLink = ({ for: author, text = reviewerLabel(author) }: { for: IActor | ITeam; text?: string }) => (
	<a className="author-link" href={author.url} title={author.url}>
		{text}
	</a>
);
