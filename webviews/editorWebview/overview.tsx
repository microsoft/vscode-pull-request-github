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
	const stickyHeightRef = React.useRef(0);
	const collapseDeltaRef = React.useRef(0);

	React.useEffect(() => {
		const title = titleRef.current;

		if (!title) {
			return;
		}

		// Small threshold to account for sub-pixel rendering
		const STICKY_THRESHOLD = 1;

		const measureStickyMetrics = () => {
			const wasStuck = title.classList.contains('stuck');
			if (!wasStuck) {
				title.classList.remove('stuck');
			}

			const unstuckHeight = title.getBoundingClientRect().height;
			// title.classList.add('stuck');
			const stuckHeight = title.getBoundingClientRect().height;
			stickyHeightRef.current = stuckHeight;
			collapseDeltaRef.current = Math.max(0, unstuckHeight - stuckHeight);

			if (!wasStuck) {
				title.classList.remove('stuck');
			}
		};

		const hasEnoughScroll = () => {
			const doc = document.documentElement;
			const body = document.body;
			const scrollHeight = Math.max(doc.scrollHeight, body.scrollHeight);
			const availableScroll = scrollHeight - window.innerHeight;
			const adjustment = title.classList.contains('stuck') ? collapseDeltaRef.current : 0;
			return availableScroll + adjustment >= stickyHeightRef.current;
		};

		// Use scroll event with requestAnimationFrame to detect when title becomes sticky
		// Check if the title's top position is at the viewport top (sticky position)
		let ticking = false;
		const handleScroll = () => {
			if (ticking) {
				return;
			}

			ticking = true;
			window.requestAnimationFrame(() => {
				if (!hasEnoughScroll()) {
					title.classList.remove('stuck');
					ticking = false;
					return;
				}

				const rect = title.getBoundingClientRect();
				// Title is stuck when its top is at position 0 (sticky top: 0)
				if (rect.top <= STICKY_THRESHOLD) {
					// title.classList.add('stuck');
				} else {
					title.classList.remove('stuck');
				}
				ticking = false;
			});
		};

		const handleResize = () => {
			measureStickyMetrics();
			handleScroll();
		};

		measureStickyMetrics();

		// Check initial state after a brief delay to ensure layout is settled
		const timeoutId = setTimeout(() => {
			measureStickyMetrics();
			handleScroll();
		}, 100);

		window.addEventListener('scroll', handleScroll, { passive: true });
		window.addEventListener('resize', handleResize);

		return () => {
			clearTimeout(timeoutId);
			window.removeEventListener('scroll', handleScroll);
			window.removeEventListener('resize', handleResize);
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
