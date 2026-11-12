/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import { OverviewItemPreview, PullRequest } from '../../src/github/views';

import { REVEAL_TIMELINE_EVENT } from '../common/constants';
import emitter from '../common/events';
import { AddComment, CommentPreview, CommentView } from '../components/comment';
import { Header, HeaderPreview } from '../components/header';
import { StatusChecksSection } from '../components/merge';
import Sidebar, { CollapsibleSidebar, SidebarPreview } from '../components/sidebar';
import { StackRecommendationBanner } from '../components/stackRecommendation';
import { StickyHeader, useStickyHeader } from '../components/stickyHeader';
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

// Keep in sync with the single column media query in index.css
export const singleColumnLayoutQuery = '(max-width: 1000px)';

export const Overview = (pr: PullRequest) => {
	const isSingleColumnLayout = useMediaQuery(singleColumnLayoutQuery);
	const titleRef = React.useRef<HTMLDivElement>(null);
	const isStuck = useStickyHeader(titleRef);

	return <>
		<StickyHeader pr={pr} visible={isStuck} />
		<StackRecommendationBanner pr={pr} title={titleRef} />
		<div id="title" className="title" ref={titleRef}>
			<div className="details">
				<Header {...pr} />
			</div>
		</div>
		{pr.isAgentSessionsWorkspace && pr.agentsOverviewTabs ?
			<OverviewTabs {...pr} />
			:
			<>
				{isSingleColumnLayout ? <CollapsibleSidebar {...pr} /> : <Sidebar {...pr} />}
				<Main pr={pr} showStatusChecks />
			</>
		}
	</>;
};

const overviewTabs = [
	{ id: 'checks', label: 'Checks/Merge' },
	{ id: 'timeline', label: 'Timeline' },
	{ id: 'metadata', label: 'Metadata' },
] as const;

type OverviewTabId = typeof overviewTabs[number]['id'];

/**
 * Pull requests in the agents window are there to be reviewed and merged, so with the experimental setting on, the
 * overview is split into tabs that start with merging and checks.
 */
const OverviewTabs = (pr: PullRequest) => {
	const [selected, setSelected] = React.useState<OverviewTabId>('checks');
	const tabs = React.useRef<HTMLButtonElement[]>([]);

	React.useEffect(() => {
		const revealTimeline = () => setSelected('timeline');
		emitter.addListener(REVEAL_TIMELINE_EVENT, revealTimeline);
		return () => {
			emitter.removeListener(REVEAL_TIMELINE_EVENT, revealTimeline);
		};
	}, []);

	React.useEffect(() => {
		// VS Code scrolls to the target of a link within the page after the page handles the click, but cannot scroll to
		// one in a hidden tab, such as the stack that the header's stack badge links to. Updating state outside of React's
		// event handlers renders synchronously, so the tab is shown before VS Code scrolls.
		const revealLinkTarget = (event: MouseEvent) => {
			const href = event.target instanceof Element ? event.target.closest('a[href^="#"]')?.getAttribute('href') : undefined;
			const panel = href ? document.getElementById(href.slice(1))?.closest<HTMLElement>('[role="tabpanel"]') : undefined;
			const tab = panel?.hidden ? overviewTabs.find(({ id }) => panel.id === `overview-panel-${id}`) : undefined;
			if (tab) {
				setSelected(tab.id);
			}
		};
		document.addEventListener('click', revealLinkTarget, true);
		return () => document.removeEventListener('click', revealLinkTarget, true);
	}, []);

	const onKeyDown = (event: React.KeyboardEvent, index: number) => {
		const targets: Record<string, number> = {
			ArrowLeft: index - 1,
			ArrowRight: index + 1,
			Home: 0,
			End: overviewTabs.length - 1,
		};
		const target = targets[event.key];
		if (target === undefined) {
			return;
		}
		event.preventDefault();
		const next = (target + overviewTabs.length) % overviewTabs.length;
		setSelected(overviewTabs[next].id);
		tabs.current[next].focus();
	};

	// Hidden panels stay rendered so that they keep their state, such as an unfinished merge.
	const panel = (id: OverviewTabId, content: JSX.Element) =>
		<div role="tabpanel" id={`overview-panel-${id}`} aria-labelledby={`overview-tab-${id}`} hidden={selected !== id}>
			{content}
		</div>;

	return <div id="overview-tabs">
		<div role="tablist" aria-label="Pull request overview" className="overview-tab-list">
			{overviewTabs.map((tab, index) =>
				<button
					key={tab.id}
					ref={element => { tabs.current[index] = element; }}
					id={`overview-tab-${tab.id}`}
					className="overview-tab"
					type="button"
					role="tab"
					aria-selected={selected === tab.id}
					aria-controls={`overview-panel-${tab.id}`}
					tabIndex={selected === tab.id ? 0 : -1}
					onClick={() => setSelected(tab.id)}
					onKeyDown={event => onKeyDown(event, index)}
				>
					{tab.label}
				</button>
			)}
		</div>
		{panel('checks', <StatusChecksSection pr={pr} isSimple={false} />)}
		{panel('timeline', <Main pr={pr} showStatusChecks={false} />)}
		{panel('metadata', <Sidebar {...pr} />)}
	</div>;
};

export const OverviewPreview = (preview: OverviewItemPreview | PullRequest) => {
	const isSingleColumnLayout = useMediaQuery(singleColumnLayoutQuery);
	return <>
		<div id="title" className="title">
			<div className="details">
				<HeaderPreview {...preview} />
			</div>
		</div>
		<SidebarPreview isSingleColumnLayout={isSingleColumnLayout} isIssue={preview.isIssue === true} />
		<div id="main">
			<div id="description">
				<CommentPreview {...preview} />
			</div>
		</div>
	</>;
};

const Main = ({ pr, showStatusChecks }: { pr: PullRequest; showStatusChecks: boolean }) => (
	<div id="main">
		<div id="description">
			<CommentView isPRDescription comment={pr} />
		</div>
		<Timeline events={pr.events} isIssue={pr.isIssue} />
		{showStatusChecks ? <StatusChecksSection pr={pr} isSimple={false} /> : null}
		<AddComment {...pr} />
	</div>
);
