/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as debounce from 'debounce';
import React, { useContext, useEffect, useState } from 'react';
import { render } from 'react-dom';
import { Overview } from './overview';
import { PullRequest } from '../../src/github/views';
import { COMMENT_TEXTAREA_ID } from '../common/constants';
import PullRequestContext from '../common/context';

export function main() {
	render(<Root>{pr => <Overview {...pr} />}</Root>, document.getElementById('app'));
}

export function Root({ children }) {
	const ctx = useContext(PullRequestContext);
	const [pr, setPR] = useState<PullRequest | undefined>(ctx.pr);
	useEffect(() => {
		ctx.onchange = setPR;
		setPR(ctx.pr);
	}, []);

	// Restore focus to comment textarea when window regains focus if user was typing
	useEffect(() => {
		const handleWindowFocus = () => {
			// Delay to let the focus event settle before checking focus state
			const FOCUS_SETTLE_DELAY_MS = 100;
			setTimeout(() => {
				const commentTextarea = document.getElementById(COMMENT_TEXTAREA_ID) as HTMLTextAreaElement;
				// Only restore focus if there's content and nothing else has focus
				if (commentTextarea && commentTextarea.value && document.activeElement === document.body) {
					commentTextarea.focus();
				}
			}, FOCUS_SETTLE_DELAY_MS);
		};

		window.addEventListener('focus', handleWindowFocus);
		return () => window.removeEventListener('focus', handleWindowFocus);
	}, []);

	useEffect(() => {
		const handleLinkClick = (event: MouseEvent) => {
			const target = event.target as HTMLElement;
			const anchor = target.closest('a[data-local-file]');
			if (anchor) {
				const file = anchor.getAttribute('data-local-file');
				const startLine = anchor.getAttribute('data-start-line');
				const endLine = anchor.getAttribute('data-end-line');
				const linkType = anchor.getAttribute('data-link-type');
				if (file && startLine && endLine) {
					// Swallow the event
					event.preventDefault();
					event.stopPropagation();

					// Open diff view for diff links, local file for blob permalinks
					if (linkType === 'diff') {
						ctx.openDiffFromLink(file, parseInt(startLine), parseInt(endLine));
					} else {
						ctx.openLocalFile(file, parseInt(startLine), parseInt(endLine));
					}
				}
			}
		};

		document.addEventListener('click', handleLinkClick, true);
		return () => document.removeEventListener('click', handleLinkClick, true);
	}, [ctx]);

	window.onscroll = debounce(() => {
		ctx.postMessage({
			command: 'scroll',
			args: {
				scrollPosition: {
					x: window.scrollX,
					y: window.scrollY
				}
			}
		});
	}, 200);
	ctx.postMessage({ command: 'ready' });
	ctx.postMessage({ command: 'pr.debug', args: 'initialized ' + (pr ? 'with PR' : 'without PR') });
	return pr ? children(pr) : <div className="loading-indicator">Loading...</div>;
}
