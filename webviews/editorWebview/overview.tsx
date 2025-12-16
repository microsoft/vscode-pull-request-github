/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import { PullRequest } from '../../src/github/views';

import { AddComment, CommentView } from '../components/comment';
import { Header } from '../components/header';
import { StatusChecksSection } from '../components/merge';
import Sidebar, { CollapsibleSidebar } from '../components/sidebar';
import { Timeline } from '../components/timeline';

const useMediaQuery = (query: string) => {
	const [matches, setMatches] = React.useState(window.matchMedia(query).matches);

	React.useEffect(() => {
		const mediaQueryList = window.matchMedia(query);
		const documentChangeHandler = () => setMatches(mediaQueryList.matches);

		mediaQueryList.addEventListener('change', documentChangeHandler);

		return () => {
			mediaQueryList.removeEventListener('change', documentChangeHandler);
		};
	}, [query]);

	return matches;
};

export const Overview = (pr: PullRequest) => {
	const isSingleColumnLayout = useMediaQuery('(max-width: 768px)');
	const titleRef = React.useRef<HTMLDivElement>(null);
	const sentinelRef = React.useRef<HTMLDivElement>(null);

	React.useEffect(() => {
		const sentinel = sentinelRef.current;
		const title = titleRef.current;
		
		if (!sentinel || !title) {
			return;
		}

		// Initially ensure title is not stuck
		title.classList.remove('stuck');

		// Use IntersectionObserver to detect when the title becomes sticky
		// The sentinel is positioned right before the title
		// When sentinel scrolls out of view (past the top), title becomes stuck
		const observer = new IntersectionObserver(
			([entry]) => {
				// When sentinel is intersecting (visible), title is NOT stuck
				// When sentinel is not intersecting (scrolled past top), title IS stuck
				if (entry.isIntersecting) {
					title.classList.remove('stuck');
				} else {
					title.classList.add('stuck');
				}
			},
			{
				// Use threshold 1 to only trigger when sentinel is fully visible/invisible
				// This prevents false positives when sentinel is partially visible
				threshold: [1]
			}
		);

		observer.observe(sentinel);

		return () => {
			observer.disconnect();
		};
	}, []);

	return <>
		{/* Sentinel element positioned just before the sticky title */}
		<div ref={sentinelRef} style={{ height: '1px' }} />
		<div id="title" className="title" ref={titleRef}>
			<div className="details">
				<Header {...pr} />
			</div>
		</div>
		{isSingleColumnLayout ?
			<>
				<CollapsibleSidebar {...pr}/>
				<Main {...pr} />
			</>
			:
			<>
				<Main {...pr} />
				<Sidebar {...pr} />
			</>
		}
	</>;
};

const Main = (pr: PullRequest) => (
	<div id="main">
		<div id="description">
			<CommentView isPRDescription comment={pr} />
		</div>
		<Timeline events={pr.events} isIssue={pr.isIssue} />
		<StatusChecksSection pr={pr} isSimple={false} />
		<AddComment {...pr} />
	</div>
);
