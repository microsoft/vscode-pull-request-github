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

export const Overview = (pr: PullRequest) => {
	const isSingleColumnLayout = useMediaQuery('(max-width: 768px)');
	const titleRef = React.useRef<HTMLDivElement>(null);
	const isStuck = useStickyHeader(titleRef);

	return <>
		<StickyHeader pr={pr} visible={isStuck} />
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

export const OverviewPreview = (preview: OverviewItemPreview | PullRequest) => {
	const isSingleColumnLayout = useMediaQuery('(max-width: 768px)');
	return <>
		<div id="title" className="title">
			<div className="details">
				<HeaderPreview {...preview} />
			</div>
		</div>
		{isSingleColumnLayout ? <SidebarPreview isSingleColumnLayout isIssue={preview.isIssue === true} /> : null}
		<div id="main">
			<div id="description">
				<CommentPreview {...preview} />
			</div>
		</div>
		{!isSingleColumnLayout ? <SidebarPreview isSingleColumnLayout={false} isIssue={preview.isIssue === true} /> : null}
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
