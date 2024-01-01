/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import { PullRequest } from '../../src/github/views';

import { AddComment, CommentView } from '../components/comment';
import { Header } from '../components/header';
import { StatusChecksSection } from '../components/merge';
import Sidebar from '../components/sidebar';
import { Timeline } from '../components/timeline';

export const Overview = (pr: PullRequest) => (
	<>
		<div id="title" className="title">
			<div className="details">
				<Header {...pr} />
			</div>
		</div>
		<Sidebar {...pr} />
		<div id="main">
			<div id="description">
				<CommentView isPRDescription comment={pr} />
			</div>
			<Timeline events={pr.events} />
			<StatusChecksSection pr={pr} isSimple={false} />
			<AddComment {...pr} />
		</div>
	</>
);
