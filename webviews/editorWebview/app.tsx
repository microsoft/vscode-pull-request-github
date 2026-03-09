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

const PROCESSED_MARKER = 'data-permalink-processed';

interface PermalinkAnchor {
	element: HTMLAnchorElement;
	url: string;
	file: string;
	startLine: number;
	endLine: number;
}

function findUnprocessedPermalinks(
	root: Document | Element,
	repoName: string,
): PermalinkAnchor[] {
	const anchors: PermalinkAnchor[] = [];
	const urlPattern = new RegExp(
		`^https://github\\.com/[^/]+/${repoName}/blob/[0-9a-f]{40}/([^#]+)#L([0-9]+)(?:-L([0-9]+))?$`,
	);

	// Find all unprocessed anchor elements
	const allAnchors = root.querySelectorAll(
		`a[href^="https://github.com/"]:not([${PROCESSED_MARKER}])`,
	);

	allAnchors.forEach((anchor: Element) => {
		const htmlAnchor = anchor as HTMLAnchorElement;

		const href = htmlAnchor.getAttribute('href');
		if (!href) return;

		const match = href.match(urlPattern);
		if (match) {
			const file = match[1];
			const startLine = parseInt(match[2]);
			const endLine = match[3] ? parseInt(match[3]) : startLine;

			anchors.push({
				element: htmlAnchor,
				url: href,
				file,
				startLine,
				endLine,
			});
		}
	});

	return anchors;
}


function updatePermalinks(
	anchors: PermalinkAnchor[],
	fileExistenceMap: Record<string, boolean>,
): void {
	anchors.forEach(({ element, url, file, startLine, endLine }) => {
		const exists = fileExistenceMap[file];
		if (!exists) {
			return;
		}

		element.setAttribute('data-local-file', file);
		element.setAttribute('data-start-line', startLine.toString());
		element.setAttribute('data-end-line', endLine.toString());

		// Add "(view on GitHub)" link after this anchor
		const githubLink = document.createElement('a');
		githubLink.href = url;
		githubLink.textContent = 'view on GitHub';
		githubLink.setAttribute(PROCESSED_MARKER, 'true');
		if (element.className) {
			githubLink.className = element.className;
		}
		element.after(
			document.createTextNode(' ('),
			githubLink,
			document.createTextNode(')'),
		);
	});
}

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
				if (file && startLine && endLine) {
					// Swallow the event and open the file
					event.preventDefault();
					event.stopPropagation();
					ctx.openLocalFile(file, parseInt(startLine), parseInt(endLine));
				}
			}
		};

		document.addEventListener('click', handleLinkClick, true);
		return () => document.removeEventListener('click', handleLinkClick, true);
	}, [ctx]);

	// Process GitHub permalinks
	useEffect(() => {
		if (!pr) return;

		const processPermalinks = debounce(async () => {
			try {
				const anchors = findUnprocessedPermalinks(document.body, pr.repo);
				anchors.forEach(({ element }) => {
					element.setAttribute(PROCESSED_MARKER, 'true');
				});

				if (anchors.length > 0) {
					const uniqueFiles = Array.from(new Set(anchors.map((a) => a.file)));
					const fileExistenceMap = await ctx.checkFilesExist(uniqueFiles);
					updatePermalinks(anchors, fileExistenceMap);
				}
			} catch (error) {
				console.error('Error processing permalinks:', error);
			}
		}, 100);

		// Start observing the document body for changes
		const observer = new MutationObserver((mutations) => {
			const hasNewNodes = mutations.some(
				({ addedNodes }) => addedNodes.length > 0,
			);

			if (hasNewNodes) {
				processPermalinks();
			}
		});
		observer.observe(document.body, {
			childList: true,
			subtree: true,
		});

		// Process the initial set of links
		processPermalinks();

		return () => {
			observer.disconnect();
			processPermalinks.clear();
		};
	}, [pr, ctx]);

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
