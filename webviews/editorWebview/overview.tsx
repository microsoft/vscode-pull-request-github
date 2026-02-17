/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import { PullRequest } from '../../src/github/views';

import PullRequestContext from '../common/context';
import { AddComment, CommentView } from '../components/comment';
import { getStatus, Header  } from '../components/header';
import { copyIcon } from '../components/icon';
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

function useStickyHeader(titleRef: React.RefObject<HTMLDivElement | null>): boolean {
	const [isStuck, setIsStuck] = React.useState(false);

	React.useEffect(() => {
		const el = titleRef.current;
		if (!el) {
			return;
		}

		const observer = new IntersectionObserver(
			([entry]) => setIsStuck(!entry.isIntersecting),
			{ threshold: 0 },
		);
		observer.observe(el);

		return () => observer.disconnect();
	}, [titleRef]);

	return isStuck;
}

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

function StickyHeader({ pr, visible }: { pr: PullRequest; visible: boolean }): JSX.Element {
	const { text, color, icon } = getStatus(pr.state, !!pr.isDraft, pr.isIssue, pr.stateReason);
	const { copyPrLink } = React.useContext(PullRequestContext);

	return (
		<div className={`sticky-header${visible ? ' visible' : ''}`}>
			<div className="sticky-header-left">
				<div id="sticky-status" className={`status-badge-${color}`}>
					<span className="icon">{icon}</span>
					<span>{text}</span>
				</div>
				<span className="sticky-header-title" dangerouslySetInnerHTML={{ __html: pr.titleHTML }} />
				<a className="sticky-header-number" href={pr.url}>#{pr.number}</a>
				<button title="Copy Link" onClick={copyPrLink} className="icon-button sticky-header-copy" aria-label="Copy Pull Request Link">
					{copyIcon}
				</button>
			</div>
		</div>
	);
}

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
