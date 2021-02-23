import { default as assert } from 'assert';
import * as React from 'react';
import { cleanup, render } from 'react-testing-library';
import { createSandbox, SinonSandbox } from 'sinon';

import { PRContext, default as PullRequestContext } from '../../common/context';
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
			</PullRequestContext.Provider>,
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
			</PullRequestContext.Provider>,
		);

		assert(children.calledWith(pr));
	});
});
