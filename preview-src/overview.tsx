import * as React from 'react';
import { PullRequest } from './cache';
import { Header } from './header';

import { AddComment, CommentBody } from './comment';
import Timeline from './timeline';
import StatusChecks from './merge';
import Sidebar from './sidebar';

export const Overview = (pr: PullRequest) =>
	<>
		<div id='title' className='title'>
			<div className='details'>
				<Header {...pr} />
			</div>
		</div>
		<Sidebar {...pr} />
		<div id='main'>
			<Description {...pr} />
			<Timeline events={pr.events} />
			<StatusChecks {...pr} />
			<AddComment {...pr} />
		</div>
	</>;

const Description = (pr: PullRequest) =>
	<div id='description'>
		<CommentBody {...pr} />
	</div>;
