/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import { getStatus } from './header';
import { copyIcon } from './icon';
import { PullRequest } from '../../src/github/views';
import PullRequestContext from '../common/context';

export function useStickyHeader(titleRef: React.RefObject<HTMLDivElement | null>): boolean {
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

export function StickyHeader({ pr, visible }: { pr: PullRequest; visible: boolean }): JSX.Element {
	const { text, color, icon } = getStatus(pr.state, !!pr.isDraft, pr.isIssue, pr.stateReason);
	const { copyPrLink } = React.useContext(PullRequestContext);

	const hiddenProps: Record<string, string> = visible ? {} : { inert: '', 'aria-hidden': 'true' };

	return (
		<div className={`sticky-header${visible ? ' visible' : ''}`} {...hiddenProps}>
			<div className="sticky-header-left">
				<div id="sticky-status" className={`status-badge-${color}`}>
					<span className="icon">{icon}</span>
					<span>{text}</span>
				</div>
				<span className="sticky-header-title" dangerouslySetInnerHTML={{ __html: pr.titleHTML }} />
				<a
					className="sticky-header-number"
					href={pr.url}
					title={pr.url}
					data-vscode-context={JSON.stringify({ url: pr.url })}
				>
					#{pr.number}
				</a>
				<button title="Copy Link" onClick={copyPrLink} className="icon-button sticky-header-copy" aria-label="Copy Pull Request Link">
					{copyIcon}
				</button>
			</div>
		</div>
	);
}
