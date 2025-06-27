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

	it('does not handle Cmd+R keyboard events to avoid conflicts with VSCode keybindings', function () {
		const pr = new PullRequestBuilder().build();
		const context = new PRContext(pr);
		const refreshSpy = sinon.spy(context, 'refresh');
		const children = sinon.stub().returns(<div />);

		render(
			<PullRequestContext.Provider value={context}>
				<Root>{children}</Root>
			</PullRequestContext.Provider>,
		);

		// Simulate Cmd+R key press
		const keyDownEvent = new KeyboardEvent('keydown', {
			key: 'r',
			metaKey: true, // Cmd key on Mac
			bubbles: true,
		});
		
		document.dispatchEvent(keyDownEvent);

		// Simulate Ctrl+R key press
		const ctrlKeyDownEvent = new KeyboardEvent('keydown', {
			key: 'r',
			ctrlKey: true, // Ctrl key on Windows/Linux
			bubbles: true,
		});
		
		document.dispatchEvent(ctrlKeyDownEvent);

		// Verify that the webview does not handle these keyboard events
		assert(!refreshSpy.called, 'refresh should not be called by webview keyboard handling');
	});
});
