/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import * as React from 'react';
import { cleanup, render } from 'react-testing-library';
import { createSandbox, SinonSandbox, SinonStub } from 'sinon';

import { PRContext, default as PullRequestContext } from '../../common/context';
import { Overview } from '../overview';
import { PullRequestBuilder } from './builder/pullRequest';

describe('Overview', function () {
	let sinon: SinonSandbox;
	let observerCallback: IntersectionObserverCallback;
	let mockIntersectionObserver: SinonStub;

	beforeEach(function () {
		sinon = createSandbox();

		// Mock IntersectionObserver
		mockIntersectionObserver = sinon.stub().callsFake((callback: IntersectionObserverCallback) => {
			observerCallback = callback;
			return {
				observe: sinon.stub(),
				disconnect: sinon.stub(),
				unobserve: sinon.stub(),
				takeRecords: sinon.stub().returns([]),
				root: null,
				rootMargin: '',
				thresholds: [0],
			};
		});
		global.IntersectionObserver = mockIntersectionObserver;
	});

	afterEach(function () {
		cleanup();
		sinon.restore();
	});

	it('renders the PR header with title', function () {
		const pr = new PullRequestBuilder().build();
		const context = new PRContext(pr);

		const out = render(
			<PullRequestContext.Provider value={context}>
				<Overview {...pr} />
			</PullRequestContext.Provider>,
		);

		assert(out.container.querySelector('.title'));
		assert(out.container.querySelector('.overview-title'));
	});

	it('applies sticky class when scrolled', function () {
		const pr = new PullRequestBuilder().build();
		const context = new PRContext(pr);

		const out = render(
			<PullRequestContext.Provider value={context}>
				<Overview {...pr} />
			</PullRequestContext.Provider>,
		);

		const titleElement = out.container.querySelector('.title');
		assert(titleElement);

		// Initial state should not have sticky class
		assert(!titleElement.classList.contains('sticky'));

		// Sticky header should exist but not be visible initially
		let stickyHeader = out.container.querySelector('.sticky-header');
		assert(stickyHeader);
		assert(!stickyHeader.classList.contains('visible'));

		// Simulate scrolling - title element is no longer intersecting (not visible)
		assert(observerCallback, 'IntersectionObserver callback should be set');
		const mockRect: DOMRectReadOnly = {
			x: 0,
			y: 0,
			width: 0,
			height: 0,
			top: 0,
			right: 0,
			bottom: 0,
			left: 0,
			toJSON: () => ({}),
		};
		const mockObserver: IntersectionObserver = {
			observe: () => {},
			disconnect: () => {},
			unobserve: () => {},
			takeRecords: () => [],
			root: null,
			rootMargin: '',
			thresholds: [0],
		};
		observerCallback(
			[
				{
					isIntersecting: false,
					target: titleElement,
					boundingClientRect: mockRect,
					intersectionRatio: 0,
					intersectionRect: mockRect,
					rootBounds: null,
					time: Date.now(),
				},
			],
			mockObserver,
		);

		// After scrolling, sticky header should become visible
		stickyHeader = out.container.querySelector('.sticky-header');
		assert(stickyHeader);
		assert(stickyHeader.classList.contains('visible'), 'Sticky header should have visible class when title is not intersecting');

		// Simulate scrolling back to top - title element is intersecting again (visible)
		observerCallback(
			[
				{
					isIntersecting: true,
					target: titleElement,
					boundingClientRect: mockRect,
					intersectionRatio: 1,
					intersectionRect: mockRect,
					rootBounds: null,
					time: Date.now(),
				},
			],
			mockObserver,
		);

		// After scrolling back to top, sticky header should be hidden again
		stickyHeader = out.container.querySelector('.sticky-header');
		assert(stickyHeader);
		assert(!stickyHeader.classList.contains('visible'), 'Sticky header should not have visible class when title is intersecting');
	});
});
