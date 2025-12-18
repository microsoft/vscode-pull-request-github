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

	React.useEffect(() => {
		const title = titleRef.current;
		
		if (!title) {
			return;
		}

		// Initially ensure title is not stuck
		title.classList.remove('stuck');

		// Small threshold to account for sub-pixel rendering
		const STICKY_THRESHOLD = 1;

		// Use scroll event with requestAnimationFrame to detect when title becomes sticky
		// Check if the title's top position is at the viewport top (sticky position)
		let ticking = false;
		const handleScroll = () => {
			if (!ticking) {
				window.requestAnimationFrame(() => {
					const rect = title.getBoundingClientRect();
					// Title is stuck when its top is at position 0 (sticky top: 0)
					if (rect.top <= STICKY_THRESHOLD) {
						title.classList.add('stuck');
					} else {
						title.classList.remove('stuck');
					}
					ticking = false;
				});
				ticking = true;
			}
		};

		// Check initial state after a brief delay to ensure layout is settled
		const timeoutId = setTimeout(handleScroll, 100);

		window.addEventListener('scroll', handleScroll, { passive: true });

		return () => {
			clearTimeout(timeoutId);
			window.removeEventListener('scroll', handleScroll);
		};
	}, []);

	return <>
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
