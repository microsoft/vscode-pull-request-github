/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as React from 'react';
import { cleanup, render, wait } from 'react-testing-library';
import { createSandbox } from 'sinon';
import { useMaxViewportWidth, ViewportWidthContext } from '../hooks';

describe('Viewport width', () => {
	const sandbox = createSandbox();

	afterEach(() => {
		cleanup();
		sandbox.restore();
	});

	const Width = ({ maxWidth = 768 }: { maxWidth?: number }) => <span>{String(useMaxViewportWidth(maxWidth))}</span>;

	it('uses independent provided widths, including the exact breakpoint, without reading the window', async () => {
		const matchMedia = sandbox.stub(window, 'matchMedia').throws(new Error('Unexpected viewport access'));
		const view = (width: number) => <>
			<ViewportWidthContext.Provider value={width}><Width /></ViewportWidthContext.Provider>
			<ViewportWidthContext.Provider value={769}><Width /></ViewportWidthContext.Provider>
		</>;
		const result = render(view(768));
		assert.strictEqual(result.container.textContent, 'truefalse');
		result.rerender(view(900));
		await wait(() => assert.strictEqual(result.container.textContent, 'falsefalse'));
		assert.strictEqual(matchMedia.callCount, 0);
	});

	it('subscribes to the window by default and removes its listener on unmount', async () => {
		const changes = new EventTarget();
		const media: MediaQueryList = {
			matches: false,
			media: '(max-width: 768px)',
			onchange: null,
			addListener: () => { throw new Error('Unexpected legacy listener'); },
			removeListener: () => { throw new Error('Unexpected legacy listener'); },
			addEventListener: changes.addEventListener.bind(changes),
			removeEventListener: changes.removeEventListener.bind(changes),
			dispatchEvent: changes.dispatchEvent.bind(changes),
		};
		const add = sandbox.spy(media, 'addEventListener');
		const remove = sandbox.spy(media, 'removeEventListener');
		const matchMedia = sandbox.stub(window, 'matchMedia').returns(media);
		const result = render(<Width />);
		await wait(() => assert.strictEqual(add.callCount, 1));
		assert.strictEqual(result.container.textContent, 'false');
		assert(matchMedia.alwaysCalledWith('(max-width: 768px)'));
		Object.defineProperty(media, 'matches', { value: true });
		changes.dispatchEvent(new Event('change'));
		await wait(() => assert.strictEqual(result.container.textContent, 'true'));
		result.unmount();
		await wait(() => assert(remove.calledWith('change', add.firstCall.args[1])));
	});
});
