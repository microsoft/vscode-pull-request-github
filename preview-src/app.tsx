import * as React from 'react';
import { render } from 'react-dom';
import { Overview } from './views';
import { PullRequest } from './cache';

export function main(pr: PullRequest) {
	render(<Overview {...pr} />, document.getElementById('main'));
}
