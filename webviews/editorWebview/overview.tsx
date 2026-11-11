/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import { OverviewItemPreview, PullRequest } from '../../src/github/views';

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
		{isSingleColumnLayout ? <CollapsibleSidebar {...pr} /> : <Sidebar {...pr} />}
		<Main {...pr} />
	</>;
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
