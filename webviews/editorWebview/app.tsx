/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as debounce from 'debounce';
import React, { useContext, useEffect, useState } from 'react';
import { render } from 'react-dom';
import { PullRequest } from '../../src/github/views';
import PullRequestContext from '../common/context';
import { Overview } from './overview';

export function main() {
	render(<Root>{pr => <Overview {...pr} />}</Root>, document.getElementById('app'));
}

export function Root({ children }) {
	const ctx = useContext(PullRequestContext);
	const [pr, setPR] = useState<PullRequest>(ctx.pr);
	useEffect(() => {
		ctx.onchange = setPR;
		setPR(ctx.pr);
	}, []);

	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			// Handle Cmd+R (Mac) or Ctrl+R (Windows/Linux) to refresh
			if (event.key === 'r' && (event.metaKey || event.ctrlKey)) {
				event.preventDefault();
				ctx.refresh();
			}
		};

		document.addEventListener('keydown', handleKeyDown);
		return () => {
			document.removeEventListener('keydown', handleKeyDown);
		};
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
