import * as React from 'react';
import assert = require('assert');
import { render, cleanup } from 'react-testing-library';
import { SinonSandbox, createSandbox } from 'sinon';

import PullRequestContext, { PRContext } from '../../common/context';
import { Root } from '../app';
import { PullRequestBuilder } from './builder/pullRequest';

describe('Root', function () {
	let sinon: SinonSandbox;

	beforeEach(function () {
		sinon = createSandbox();
	});

	afterEach(function () {
		cleanup();
		sinon.restore();
	});

	it('displays "loading" while the PR is loading', function () {
		const context = new PRContext();
		const children = sinon.stub();

		assert(!context.pr);

		const out = render(
			<PullRequestContext.Provider value={context}>
				<Root>{children}</Root>
			</PullRequestContext.Provider>
		);

		assert(out.queryByText('Loading...'));
		assert(!children.called);
	});

	it('renders its child prop with a pull request from the context', function () {
		const pr = new PullRequestBuilder().build();
		const context = new PRContext(pr);
		const children = sinon.stub().returns(<div />);

		render(
			<PullRequestContext.Provider value={context}>
				<Root>{children}</Root>
			</PullRequestContext.Provider>
		);

		assert(children.calledWith(pr));
	});
});