import * as React from 'react';
import { PullRequest } from './cache';
import { Header } from './header';

import { AddComment, CommentBody } from './comment';
import Timeline from './timeline';
import StatusChecks from './merge';

export const Overview = (pr: PullRequest) =>
	<>
		<div className='details'>
			<Header {...pr} />
			<Description {...pr} />
		</div>
		<Timeline events={pr.events} />
		<StatusChecks {...pr} />
		<AddComment {...pr} />
	</>;

const Description = (pr: PullRequest) =>
	<div className='description-container'><CommentBody {...pr} /></div>;
