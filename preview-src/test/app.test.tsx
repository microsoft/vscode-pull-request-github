import * as React from 'react';
import * as assert from 'assert';
import { render, cleanup } from 'react-testing-library';

import PullRequestContext, { PRContext } from '../context';
import { Root } from '../app';
import { SinonSandbox, createSandbox } from 'sinon';

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
});