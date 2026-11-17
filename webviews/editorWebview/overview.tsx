/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import { EventType } from '../../src/common/timelineEvent';
import { CheckState, GithubItemStateEnum } from '../../src/github/interface';
import { OverviewItemPreview, PullRequest } from '../../src/github/views';

import { REVEAL_TIMELINE_EVENT } from '../common/constants';
import PullRequestContext from '../common/context';
import emitter from '../common/events';
import { AddComment, CommentPreview, CommentView } from '../components/comment';
import { Header, HeaderPreview } from '../components/header';
import { loadingIcon } from '../components/icon';
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

const hasFailedChecks = (pr: PullRequest) =>
	pr.state === GithubItemStateEnum.Open && !!pr.status?.statuses.some(status => status.state === CheckState.Failure);

// Draft comments are not posted yet, so they are not part of a review thread that can be resolved.
const hasUnresolvedComments = (pr: PullRequest) =>
	pr.state === GithubItemStateEnum.Open && pr.events.some(event => event.event === EventType.Reviewed
		&& event.comments.some(comment => !!comment.threadId && !comment.isResolved && !comment.isDraft));

interface SessionActionProps {
	label: string;
	run: () => Promise<unknown>;
}

/** Puts a prompt to act on what the selected tab shows in the input of the agent session. It is on the right of the tabs. */
const SessionAction = ({ label, run, hidden }: SessionActionProps & { hidden: boolean }) => {
	const [busy, setBusy] = React.useState(false);
	const onClick = async () => {
		setBusy(true);
		try {
			await run();
		} finally {
			setBusy(false);
		}
	};
	return <div className="overview-session-action" hidden={hidden}>
		<button type="button" title={label} disabled={busy} onClick={onClick}>
			{busy ? <span className="loading-button">{loadingIcon}</span> : null}
			{label}
		</button>
	</div>;
};

/**
 * Pull requests in the agents window are there to be reviewed and merged, so with the experimental setting on, the
 * overview is split into tabs that start with merging and checks.
 */
const OverviewTabs = (pr: PullRequest) => {
	const { fixChecksInSession, addressCommentsInSession } = React.useContext(PullRequestContext);
	const [selected, setSelected] = React.useState<OverviewTabId>('checks');
	const tabs = React.useRef<HTMLButtonElement[]>([]);

	React.useEffect(() => {
		const revealTimeline = () => setSelected('timeline');
		emitter.addListener(REVEAL_TIMELINE_EVENT, revealTimeline);
		return () => {
			emitter.removeListener(REVEAL_TIMELINE_EVENT, revealTimeline);
		};
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

	const sessionActions: Partial<Record<OverviewTabId, SessionActionProps>> = {
		checks: hasFailedChecks(pr) ? { label: 'Fix Checks in Session', run: fixChecksInSession } : undefined,
		timeline: hasUnresolvedComments(pr) ? { label: 'Address Comments in Session', run: addressCommentsInSession } : undefined,
	};

	return <div id="overview-tabs">
		<div className="overview-tab-bar">
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
			{/* Like the panels, the actions of the other tabs stay rendered, so that one that is running stays disabled. */}
			{overviewTabs.map(tab => {
				const action = sessionActions[tab.id];
				return action ? <SessionAction key={tab.id} {...action} hidden={selected !== tab.id} /> : null;
			})}
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
