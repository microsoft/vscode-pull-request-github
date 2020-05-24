import * as React from 'react';
import { useContext, useState, useEffect } from 'react';
import { render } from 'react-dom';
import { Overview } from './overview';
import PullRequestContext from './context';
import { PullRequest } from './cache';

export function main() {
	render(
		<Root>{pr => <Overview {...pr} />}</Root>
	, document.getElementById('app'));
}

export function Root({ children }) {
	const ctx = useContext(PullRequestContext);
	const [pr, setPR] = useState<PullRequest>(ctx.pr);
	useEffect(() => {
		ctx.onchange = setPR;
		setPR(ctx.pr);
	}, []);
	ctx.postMessage({ command: 'pr.debug', args: ('initialized ' + (pr ? 'with PR' : 'without PR'))});
	return pr ? children(pr) : <div className='loading-indicator'>Loading...</div>;
}