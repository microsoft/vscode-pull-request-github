/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import React, { useContext, useEffect, useState } from 'react';
import { render } from 'react-dom';
import { Overview } from './overview';
import { PullRequest } from '../../src/github/views';
import PullRequestContext, { PRContext } from '../common/context';
import { WebviewProvider } from '../common/webviewProvider';

export function main() {
	render(
		<WebviewProvider context={PullRequestContext} createContext={host => new PRContext(host)}>
			<Root>{pr => <Overview {...pr} />}</Root>
		</WebviewProvider>,
		document.getElementById('app')
	);
}

export function Root({ children }) {
	const ctx = useContext(PullRequestContext);
	const [pr, setPR] = useState<PullRequest>(ctx.pr);
	useEffect(() => {
		ctx.onchange = setPR;
		setPR(ctx.pr);
		return () => {
			ctx.onchange = null;
		};
	}, [ctx]);
	ctx.notify({ command: 'ready' });
	ctx.notify({ command: 'pr.debug', args: 'initialized ' + (pr ? 'with PR' : 'without PR') });
	return pr ? children(pr) : <div className="loading-indicator">Loading...</div>;
}
