/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as React from 'react';
import { cleanup, render, wait } from 'react-testing-library';
import { createSandbox, SinonSandbox } from 'sinon';
import { dateFromNow } from '../../../src/common/utils';
import { Timestamp, TimestampFormatContext } from '../timestamp';

describe('Timestamp', () => {
	let sandbox: SinonSandbox;

	beforeEach(() => {
		sandbox = createSandbox();
	});

	afterEach(() => {
		cleanup();
		sandbox.restore();
	});

	it('uses an instance-local formatter without scheduling clock updates', async () => {
		const interval = sandbox.spy(window, 'setInterval');
		const format = {
			relative: (date: Date | string) => `fixed ${new Date(date).toISOString()}`,
			title: (date: Date | string) => new Date(date).toISOString(),
		};
		const view = (date: string) => <TimestampFormatContext.Provider value={format}>
			<Timestamp date={date} href="#event" />
		</TimestampFormatContext.Provider>;
		const out = render(view('2025-01-15T10:00:00Z'));
		const link = out.container.querySelector('a')!;
		assert.strictEqual(link.textContent, 'fixed 2025-01-15T10:00:00.000Z');
		assert.strictEqual(link.title, '2025-01-15T10:00:00.000Z');
		assert.strictEqual(link.getAttribute('href'), '#event');
		out.rerender(view('2025-01-16T10:00:00Z'));
		await wait(() => assert.strictEqual(link.textContent, 'fixed 2025-01-16T10:00:00.000Z'));
		assert.strictEqual(interval.callCount, 0);
	});

	it('preserves the default formatter and disposes live updates', async () => {
		const date = new Date();
		const interval = sandbox.spy(window, 'setInterval');
		const clear = sandbox.spy(globalThis, 'clearInterval');
		const out = render(<Timestamp date={date} />);
		assert.strictEqual(out.container.textContent, dateFromNow(date));
		assert.strictEqual(out.container.querySelector('.timestamp')!.getAttribute('title'), date.toLocaleString());
		await wait(() => assert.strictEqual(interval.callCount, 1));
		out.unmount();
		await wait(() => assert(clear.calledWith(interval.firstCall.returnValue)));
	});

	it('does not leak one instance formatter into another', () => {
		const date = '2025-01-15T10:00:00Z';
		const out = render(<>
			<TimestampFormatContext.Provider value={{ relative: () => 'fixed', title: () => 'UTC' }}>
				<Timestamp date={date} />
			</TimestampFormatContext.Provider>
			<Timestamp date={date} />
		</>);
		const timestamps = out.container.querySelectorAll('.timestamp');
		assert.strictEqual(timestamps[0].textContent, 'fixed');
		assert.strictEqual(timestamps[1].textContent, dateFromNow(date));
	});
});
