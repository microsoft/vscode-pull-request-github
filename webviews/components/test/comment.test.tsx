/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as React from 'react';
import { act, cleanup, fireEvent, render, wait } from 'react-testing-library';
import { createSandbox } from 'sinon';
import { createTestHost } from '../../../src/test/webviews/testHost';
import PullRequestContext, { PRContext } from '../../common/context';
import emitter from '../../common/events';
import { vscodeTransport as vscode } from '../../common/host';
import { PullRequestBuilder } from '../../editorWebview/test/builder/pullRequest';
import { AddComment } from '../comment';

describe('Comment composer quote replies', () => {
	afterEach(() => {
		cleanup();
		vscode.setState(undefined);
	});

	it('updates a controlled draft through the React change event without warnings', () => {
		const sandbox = createSandbox();
		const context = new PRContext(createTestHost(new PullRequestBuilder().build()));
		context.updatePR({ pendingCommentText: 'Existing draft' });
		const errors = sandbox.stub(console, 'error');
		const out = render(<PullRequestContext.Provider value={context}>
			<AddComment {...context.pr!} />
		</PullRequestContext.Provider>);
		try {
			const textarea = out.container.querySelector('textarea')!;
			assert.strictEqual(textarea.value, 'Existing draft');
			fireEvent.change(textarea, { target: { value: 'Updated draft' } });
			assert.strictEqual(context.pr!.pendingCommentText, 'Updated draft');
			assert.deepStrictEqual(errors.args, []);
		} finally {
			out.unmount();
			context.dispose();
			sandbox.restore();
		}
	});

	it('registers once across rerenders and removes its listener on unmount', async () => {
		const sandbox = createSandbox();
		const pr = new PullRequestBuilder().build();
		const context = new PRContext(createTestHost(pr));
		const update = sandbox.spy(context, 'updatePR');
		const previousListeners = emitter.listenerCount('quoteReply');
		const view = (busy: boolean) => <PullRequestContext.Provider value={context}>
			<AddComment {...pr} busy={busy} />
		</PullRequestContext.Provider>;
		const out = render(view(false));
		try {
			await wait(() => assert.strictEqual(emitter.listenerCount('quoteReply'), previousListeners + 1));
			out.rerender(view(true));
			out.rerender(view(false));
			assert.strictEqual(emitter.listenerCount('quoteReply'), previousListeners + 1);
			const textarea = out.container.querySelector('textarea')!;
			textarea.scrollIntoView = sandbox.spy();
			act(() => { emitter.emit('quoteReply', 'First line\nSecond line'); });
			assert.strictEqual(update.callCount, 1);
			assert.strictEqual(context.pr!.pendingCommentText, '> First line\n> Second line \n\n');
			assert.strictEqual(document.activeElement, textarea);
			out.unmount();
			await wait(() => assert.strictEqual(emitter.listenerCount('quoteReply'), previousListeners));
			emitter.emit('quoteReply', 'After unmount');
			assert.strictEqual(update.callCount, 1);
		} finally {
			out.unmount();
			context.dispose();
			sandbox.restore();
		}
	});
});
