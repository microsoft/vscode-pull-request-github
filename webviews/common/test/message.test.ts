/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { createSandbox } from 'sinon';
import { vscodeTransport as vscode } from '../host';
import { MessageHandler } from '../message';

describe('MessageHandler pending replies', () => {
	const sandbox = createSandbox();
	let handler: MessageHandler;
	beforeEach(() => {
		handler = new MessageHandler(vscode);
	});
	afterEach(() => {
		handler.dispose();
		sandbox.restore();
	});

	it('releases successful and rejected replies while keeping outstanding requests', async () => {
		const requests: string[] = [];
		sandbox.stub(vscode, 'postMessage').callsFake((message: { req: string }) => {
			requests.push(message.req);
		});
		const commands = sandbox.spy();
		handler.onCommand(commands);
		const first = handler.postMessage({ command: 'first' });
		const second = handler.postMessage({ command: 'second' });
		const secondAssertion = assert.rejects(second, error => error === 'Request failed');
		assert.strictEqual(handler['_pendingReplies'].size, 2);

		window.dispatchEvent(new MessageEvent('message', { data: { seq: requests[0], res: 'Result' } }));
		assert.strictEqual(await first, 'Result');
		assert.strictEqual(handler['_pendingReplies'].size, 1);
		window.dispatchEvent(new MessageEvent('message', { data: { seq: requests[1], err: 'Request failed' } }));
		await secondAssertion;
		assert.strictEqual(handler['_pendingReplies'].size, 0);

		window.dispatchEvent(new MessageEvent('message', { data: { seq: requests[0], res: 'Duplicate' } }));
		window.dispatchEvent(new MessageEvent('message', { data: { seq: 'unknown', res: 'Unknown' } }));
		assert.strictEqual(commands.callCount, 0);
		window.dispatchEvent(new MessageEvent('message', { data: { res: 'Command' } }));
		assert(commands.calledOnceWithExactly('Command'));
	});

	it('releases callbacks when sending throws synchronously', async () => {
		const failure = new Error('Transport failed');
		sandbox.stub(vscode, 'postMessage').throws(failure);
		await assert.rejects(handler.postMessage({ command: 'failure' }), error => error === failure);
		assert.strictEqual(handler['_pendingReplies'].size, 0);
	});
});
