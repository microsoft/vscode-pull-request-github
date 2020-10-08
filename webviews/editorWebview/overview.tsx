/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import { PullRequest } from '../common/cache';
import { Header } from '../components/header';

import { AddComment, CommentView } from '../components/comment';
import Timeline from '../components/timeline';
import StatusChecks from '../components/merge';
import Sidebar from '../components/sidebar';

export const Overview = (pr: PullRequest) =>
	<>
		<div id='title' className='title'>
			<div className='details'>
				<Header {...pr} />
			</div>
		</div>
		<Sidebar {...pr} />
		<div id='main'>
			<div id='description'>
				<CommentView isPRDescription {...pr} />
			</div>
			<Timeline events={pr.events} />
			<StatusChecks pr={pr} isSimple={false}/>
			<AddComment {...pr} />
		</div>
	</>;
