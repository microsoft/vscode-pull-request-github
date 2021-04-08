/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import { Icon } from './icon';

export const Avatar = ({ url, avatarUrl }: { url: string; avatarUrl: string }) => (
	<a className="avatar-link" href={url}>
		{avatarUrl ? (
			<img className="avatar" src={avatarUrl} alt="" />
		) : (
			<Icon className="avatar-icon" src={require('../../resources/icons/dark/azdo.svg')} />
		)}
	</a>
);

export const AuthorLink = ({ url, text }: { url: string; text: string }) => (
	<a className="author-link" href={url}>
		{text}
	</a>
);
