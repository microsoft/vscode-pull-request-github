/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as debounce from 'debounce';
import React, { useContext, useEffect, useState } from 'react';
import { render } from 'react-dom';
import { Overview, OverviewPreview } from './overview';
import { extractCodeReferenceLinkMetadata } from '../../src/common/utils';
import { PullRequest, PullRequestPreview } from '../../src/github/views';
import { COMMENT_TEXTAREA_ID } from '../common/constants';
import PullRequestContext, { PRContext } from '../common/context';
import { createWebviewHost } from '../common/host';
import { rethrowUnlessDisposed } from '../common/message';

export function main() {
	const host = createWebviewHost();
	const context = new PRContext(host);
	render(
		<PullRequestContext.Provider value={context}>
			<Root>{pr => <Overview {...pr} />}</Root>
		</PullRequestContext.Provider>,
		document.getElementById('app')
	);
}

export function Root({ children }) {
	const ctx = useContext(PullRequestContext);
	const [pr, setPR] = useState<PullRequest | undefined>(ctx.pr);
	const [preview, setPreview] = useState<PullRequestPreview | undefined>(ctx.preview);
	useEffect(() => {
		ctx.onchange = setPR;
		ctx.onPreviewChange = setPreview;
		setPR(ctx.pr);
		setPreview(ctx.preview);
		return () => {
			ctx.onchange = null;
			ctx.onPreviewChange = null;
		};
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
				const metadata = extractCodeReferenceLinkMetadata(anchor);
				if (metadata) {
					// Prevent default navigation, handlers will fallback to opening the link externally if they fail
					event.preventDefault();
					event.stopPropagation();

					// Open diff view for diff links, local file for blob permalinks
					if (metadata.linkType === 'diff') {
						ctx.openDiffFromLink(metadata.localFile, metadata.startLine, metadata.endLine, metadata.href);
					} else {
						ctx.openLocalFile(metadata.localFile, metadata.startLine, metadata.endLine, metadata.href);
					}
				}
			}
		};

		document.addEventListener('click', handleLinkClick, true);
		return () => document.removeEventListener('click', handleLinkClick, true);
	}, [ctx]);

	useEffect(() => {
		const onScroll = debounce(() => {
			ctx.postMessage({
				command: 'scroll',
				args: {
					scrollPosition: {
						x: window.scrollX,
						y: window.scrollY
					}
				}
			}).catch(rethrowUnlessDisposed);
		}, 200);
		window.addEventListener('scroll', onScroll);
		return () => {
			window.removeEventListener('scroll', onScroll);
			onScroll.clear();
		};
	}, [ctx]);
	ctx.postMessage({ command: 'ready' }).catch(rethrowUnlessDisposed);
	ctx.postMessage({ command: 'pr.debug', args: 'initialized ' + (pr ? 'with PR' : 'without PR') }).catch(rethrowUnlessDisposed);
	return pr ? children(pr) : preview ? <OverviewPreview {...preview} /> : <div className="loading-indicator">Loading...</div>;
}
