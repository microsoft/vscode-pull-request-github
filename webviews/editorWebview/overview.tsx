/* eslint-disable import/no-named-as-default */
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import { PullRequest } from '../common/cache';

import { AddComment, CommentView } from '../components/comment';
import { Header } from '../components/header';
import StatusChecks from '../components/merge';
import Sidebar from '../components/sidebar';
import Timeline from '../components/timeline';

export const Overview = (pr: PullRequest) => (
	<>
		<div id="title" className="title">
			<div className="details">
				<Header {...pr} />
			</div>
		</div>
		<Sidebar {...pr} />
		<div id="main">
			<StatusChecks pr={pr} isSimple={false} />
			<div id="description">
				<CommentView
					isPRDescription
					threadId={0}
					content={pr.body}
					author={{
						displayName: pr.author.name,
						profileUrl: pr.author.url,
						id: pr.author.id,
						uniqueName: pr.author.email,
						_links: { avatar: { href: pr.author.avatarUrl } },
					}}
					_links={{ self: { href: pr.url } }}
					publishedDate={new Date(pr.createdAt)}
					canEdit={pr.canEdit}
				/>
			</div>
			<AddComment {...pr} />
			<Timeline threads={pr.threads} currentUser={pr.currentUser} />
		</div>
	</>
);
