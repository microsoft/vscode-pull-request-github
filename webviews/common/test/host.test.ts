/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as React from 'react';
import { unmountComponentAtNode } from 'react-dom';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, render, wait } from 'react-testing-library';
import { createSandbox } from 'sinon';
import { CreateParamsNew } from '../../../common/views';
import { PullRequest } from '../../../src/github/views';
import { createTestHost } from '../../../src/test/webviews/testHost';
import { PullRequestBuilder } from '../../editorWebview/test/builder/pullRequest';
import { NotificationMessage, ReplyMessage, RequestMessage, vscodeTransport, WebviewHost, WebviewTransport } from '../host';
import { WebviewProvider } from '../webviewProvider';

function importContextsWithoutVsCodeApi() {
	const sandbox = createSandbox();
	sandbox.stub(globalThis as typeof globalThis & { acquireVsCodeApi(): unknown }, 'acquireVsCodeApi')
		.throws(new Error('Importing a context must not acquire the VS Code API'));
	const listeners = sandbox.spy(window, 'addEventListener');
	try {
		const pr = require('../context') as typeof import('../context');
		const create = require('../createContextNew') as typeof import('../createContextNew');
		const message = require('../message') as typeof import('../message');
		assert.strictEqual(listeners.callCount, 0);
		return { pr, create, message };
	} finally {
		sandbox.restore();
	}
}

const imported = importContextsWithoutVsCodeApi();
const { PRContext, default: PullRequestContext } = imported.pr;
const { CreatePRContextNew, default: PullRequestContextNew } = imported.create;
const { MessageHandler, MessageHandlerDisposedError } = imported.message;

class TestTransport implements WebviewTransport {
	public state: unknown;
	public readonly messages: (RequestMessage | NotificationMessage)[] = [];
	public readonly listeners = new Set<(message: ReplyMessage) => void>();

	getState<T>(): T | undefined {
		return this.state as T | undefined;
	}

	setState<T>(state: T): void {
		this.state = state;
	}

	postMessage(message: RequestMessage | NotificationMessage): void {
		this.messages.push(message);
	}

	onMessage(listener: (message: ReplyMessage) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	reply(index: number, res: unknown): void {
		this.emit({ seq: this.messages[index].req, res });
	}

	emit(message: ReplyMessage): void {
		for (const listener of this.listeners) {
			listener(message);
		}
	}
}

describe('Webview host isolation', () => {
	it('imports messaging and both contexts without acquiring the VS Code API', () => {
		assert(imported.pr.PRContext);
		assert(imported.create.CreatePRContextNew);
		assert(imported.message.MessageHandler);
	});

	it('returns the exact supplied contexts, including nested providers, without a production host', () => {
		const sandbox = createSandbox();
		sandbox.stub(globalThis as typeof globalThis & { acquireVsCodeApi(): unknown }, 'acquireVsCodeApi')
			.throws(new Error('Unexpected VS Code API access'));
		const first = new PRContext(createTestHost(new PullRequestBuilder().build(), new TestTransport()));
		const second = new PRContext(createTestHost(new PullRequestBuilder().build(), new TestTransport()));
		const create = new CreatePRContextNew(createTestHost(undefined, new TestTransport()));
		const observed: InstanceType<typeof PRContext>[] = [];
		const PRConsumer = () => {
			observed.push(React.useContext(PullRequestContext));
			return null;
		};
		const CreateConsumer = () => {
			assert.strictEqual(React.useContext(PullRequestContextNew), create);
			return null;
		};
		try {
			renderToStaticMarkup(React.createElement(PullRequestContext.Provider, { value: first },
				React.createElement(PRConsumer),
				React.createElement(PullRequestContext.Provider, { value: second }, React.createElement(PRConsumer)),
				React.createElement(PRConsumer),
				React.createElement(PullRequestContextNew.Provider, { value: create }, React.createElement(CreateConsumer)),
			));
			assert.strictEqual(observed.length, 3);
			assert.strictEqual(observed[0], first);
			assert.strictEqual(observed[1], second);
			assert.strictEqual(observed[2], first);
		} finally {
			first.dispose();
			second.dispose();
			create.dispose();
			sandbox.restore();
		}
	});

	it('owns and disposes contexts and hosts in all production entry points', () => {
		const { main: editor } = require('../../editorWebview/app') as typeof import('../../editorWebview/app');
		const { main: activity } = require('../../activityBarView/app') as typeof import('../../activityBarView/app');
		const { main: create } = require('../../createPullRequestViewNew/app') as typeof import('../../createPullRequestViewNew/app');
		const sandbox = createSandbox();
		sandbox.stub(globalThis as typeof globalThis & { acquireVsCodeApi(): unknown }, 'acquireVsCodeApi')
			.throws(new Error('Unexpected VS Code API access'));
		const app = document.createElement('div');
		app.id = 'app';
		document.body.appendChild(app);
		try {
			for (const [main, Context] of [[editor, PRContext], [activity, PRContext], [create, CreatePRContextNew]] as const) {
				const host = new TestTransport();
				const state = sandbox.stub(vscodeTransport, 'getState').returns(undefined);
				const persist = sandbox.stub(vscodeTransport, 'setState').callsFake(value => host.setState(value));
				const send = sandbox.stub(vscodeTransport, 'postMessage').callsFake(message => host.postMessage(message));
				const listen = sandbox.stub(vscodeTransport, 'onMessage').callsFake(listener => host.onMessage(listener));
				const disposeContext = sandbox.spy(Context.prototype, 'dispose');
				const disposeHost = sandbox.spy(MessageHandler.prototype, 'dispose');
				try {
					for (let mount = 1; mount <= 2; mount++) {
						act(() => main());
						assert(app.childElementCount > 0);
						assert.strictEqual(listen.callCount, mount);
						assert.strictEqual(host.listeners.size, 1);
						act(() => main());
						assert.strictEqual(listen.callCount, mount);
						act(() => { unmountComponentAtNode(app); });
						assert.strictEqual(host.listeners.size, 0);
						assert.strictEqual(disposeContext.callCount, mount);
						assert.strictEqual(disposeHost.callCount, mount);
						assert(disposeContext.lastCall.calledBefore(disposeHost.lastCall));
						assert(host.messages.some(message => message.command === 'ready'));
						assert(host.messages.every(message => message.req === undefined));
					}
				} finally {
					act(() => { unmountComponentAtNode(app); });
					disposeContext.restore();
					disposeHost.restore();
					state.restore();
					persist.restore();
					send.restore();
					listen.restore();
				}
			}
		} finally {
			app.remove();
			sandbox.restore();
		}
	});

	it('provides contexts without acquiring a VS Code API or installing global listeners', () => {
		const sandbox = createSandbox();
		const acquire = sandbox.stub(globalThis as typeof globalThis & { acquireVsCodeApi(): unknown }, 'acquireVsCodeApi')
			.throws(new Error('A fixture must not acquire the VS Code API'));
		const prTransport = new TestTransport();
		const createTransport = new TestTransport();
		const prHost = createTestHost(new PullRequestBuilder().build(), prTransport);
		const createHost = createTestHost(undefined, createTransport);
		let prContext: InstanceType<typeof PRContext> | undefined;
		let createContext: InstanceType<typeof CreatePRContextNew> | undefined;
		try {
			prContext = new PRContext(prHost);
			createContext = new CreatePRContextNew(createHost);
			assert.strictEqual(acquire.callCount, 0);
			assert.strictEqual(prTransport.listeners.size, 1);
			assert.strictEqual(createTransport.listeners.size, 1);
			assert(PullRequestContext);
			assert(PullRequestContextNew);
		} finally {
			prContext?.dispose();
			createContext?.dispose();
			sandbox.restore();
		}
		assert.strictEqual(prTransport.listeners.size, 1);
		assert.strictEqual(createTransport.listeners.size, 1);
		prHost.dispose();
		createHost.dispose();
		assert.strictEqual(prTransport.listeners.size, 0);
		assert.strictEqual(createTransport.listeners.size, 0);
	});

	it('rejects outstanding requests when the owning provider unmounts', async () => {
		let ownedHost: WebviewHost | undefined;
		let ownedContext: InstanceType<typeof PRContext> | undefined;
		const root = render(React.createElement(WebviewProvider<InstanceType<typeof PRContext>>, {
			context: PullRequestContext,
			createContext: host => {
				ownedHost = host;
				ownedContext = new PRContext(host);
				return ownedContext;
			},
			children: React.createElement('div'),
		}));
		assert(ownedHost);
		assert(ownedContext);
		const pending = ownedContext.postMessage({ command: 'pending' });
		const rejected = assert.rejects(pending, MessageHandlerDisposedError);
		root.unmount();
		await rejected;
		assert.throws(() => ownedHost!.notify({ command: 'ready' }), MessageHandlerDisposedError);
	});

	it('rebinds editor and activity subscriptions when the supplied context changes', async () => {
		const { Root: Editor } = require('../../editorWebview/app') as typeof import('../../editorWebview/app');
		const { Root: Activity } = require('../../activityBarView/app') as typeof import('../../activityBarView/app');
		for (const Root of [Editor, Activity]) {
			const firstTransport = new TestTransport();
			const secondTransport = new TestTransport();
			const pr = new PullRequestBuilder().build();
			const first = new PRContext(createTestHost({ ...pr, title: 'First' }, firstTransport));
			const second = new PRContext(createTestHost({ ...pr, title: 'Second' }, secondTransport));
			const view = (context: InstanceType<typeof PRContext>) => React.createElement(PullRequestContext.Provider, { value: context },
				React.createElement(Root, { children: (value: PullRequest) => React.createElement('span', null, value.title) }));
			const root = render(view(first));
			try {
				await wait(() => assert.strictEqual(root.container.textContent, 'First'));
				root.rerender(view(second));
				await wait(() => {
					assert.strictEqual(root.container.textContent, 'Second');
					assert.strictEqual(first.onchange, null);
					assert.strictEqual(first.onPreviewChange, null);
				});
				act(() => firstTransport.emit({ res: { command: 'pr.update', pullrequest: { title: 'Stale' } } }));
				assert.strictEqual(root.container.textContent, 'Second');
				act(() => secondTransport.emit({ res: { command: 'pr.update', pullrequest: { title: 'Updated' } } }));
				await wait(() => assert.strictEqual(root.container.textContent, 'Updated'));
				if (Root === Editor) {
					assert(second.onPreviewChange);
				}
				root.unmount();
				await wait(() => assert.strictEqual(second.onchange, null));
				assert.strictEqual(secondTransport.listeners.size, 1);
			} finally {
				root.unmount();
				first.dispose();
				second.dispose();
			}
		}
	});

	it('rebinds the create view subscription when the supplied context changes', async () => {
		const { Root } = require('../../createPullRequestViewNew/app') as typeof import('../../createPullRequestViewNew/app');
		const first = new CreatePRContextNew(createTestHost());
		const second = new CreatePRContextNew(createTestHost());
		first.updateState({ pendingTitle: 'First' });
		second.updateState({ pendingTitle: 'Second' });
		const view = (context: InstanceType<typeof CreatePRContextNew>) => React.createElement(PullRequestContextNew.Provider, { value: context },
			React.createElement(Root, { children: (params: CreateParamsNew) => React.createElement('span', null, params.pendingTitle) }));
		const root = render(view(first));
		try {
			await wait(() => assert.strictEqual(root.container.textContent, 'First'));
			root.rerender(view(second));
			await wait(() => {
				assert.strictEqual(first.onchange, null);
				assert.strictEqual(root.container.textContent, 'Second');
			});
			act(() => first.updateState({ pendingTitle: 'Stale' }));
			assert.strictEqual(root.container.textContent, 'Second');
			act(() => second.updateState({ pendingTitle: 'Updated' }));
			await wait(() => assert.strictEqual(root.container.textContent, 'Updated'));
			root.unmount();
			await wait(() => assert.strictEqual(second.onchange, null));
		} finally {
			root.unmount();
			first.dispose();
			second.dispose();
		}
	});

	it('routes simultaneous replies per handler, without mutating requests or treating replies as commands', async () => {
		const host = new TestTransport();
		const commands: unknown[] = [];
		const first = createTestHost(undefined, host);
		const second = createTestHost(undefined, host);
		first.onCommand(message => commands.push(message));
		second.onCommand(message => commands.push(message));
		const message = { command: 'pr.get-stack' };
		const firstRequest = first.postMessage(message);
		const secondRequest = second.postMessage(message);
		assert.deepStrictEqual(message, { command: 'pr.get-stack' });
		assert.notStrictEqual(host.messages[0].req, host.messages[1].req);
		host.reply(1, 'second');
		host.reply(0, 'first');
		assert.strictEqual(await firstRequest, 'first');
		assert.strictEqual(await secondRequest, 'second');
		host.reply(0, 'duplicate');
		assert.deepStrictEqual(commands, []);
		first.dispose();
		second.dispose();
	});

	it('unsubscribes contexts without disposing their shared host or cancelling its requests', async () => {
		const transport = new TestTransport();
		const pr = new PullRequestBuilder().build();
		const host = createTestHost(pr, transport);
		const first = new PRContext(host);
		const second = new PRContext(host);
		const pending = first.postMessage({ command: 'pr.get-stack' });
		first.dispose();
		first.dispose();
		assert.strictEqual(transport.listeners.size, 1);
		transport.reply(0, 'reply after context disposal');
		assert.strictEqual(await pending, 'reply after context disposal');
		transport.emit({ res: { command: 'pr.initialize', pullrequest: { ...pr, title: 'Still subscribed' } } });
		assert.strictEqual(first.pr?.title, pr.title);
		assert.strictEqual(second.pr?.title, 'Still subscribed');
		second.dispose();
		assert.strictEqual(transport.listeners.size, 1);
		host.dispose();
		assert.strictEqual(transport.listeners.size, 0);
	});

	it('rejects errors and outstanding requests and removes listeners on idempotent disposal', async () => {
		const host = new TestTransport();
		const handler = createTestHost(undefined, host);
		const rejected = handler.postMessage({ command: 'pr.update-stack' });
		const assertion = assert.rejects(rejected, reason => reason === 'Update failed');
		host.emit({ seq: host.messages[0].req, err: 'Update failed' });
		await assertion;
		const pending = handler.postMessage({ command: 'pr.get-stack' });
		const pendingAssertion = assert.rejects(pending, MessageHandlerDisposedError);
		handler.dispose();
		handler.dispose();
		await pendingAssertion;
		assert.strictEqual(host.listeners.size, 0);
		await assert.rejects(handler.postMessage({ command: 'pr.get-stack' }), MessageHandlerDisposedError);
		assert.strictEqual(host.messages.length, 2);
	});

	it('propagates synchronous host failures rather than leaving requests pending', async () => {
		const host = new TestTransport();
		const failure = new Error('Unexpected command');
		host.postMessage = () => { throw failure; };
		const handler = createTestHost(undefined, host);
		await assert.rejects(handler.postMessage({ command: 'unexpected' }), error => error === failure);
		handler.dispose();
	});

	it('persists PR changes and incoming commands only in the owning context', () => {
		const firstHost = new TestTransport();
		const secondHost = new TestTransport();
		const pr = new PullRequestBuilder().build();
		const first = new PRContext(createTestHost({ ...pr }, firstHost));
		const second = new PRContext(createTestHost({ ...pr }, secondHost));
		first.updatePR({ title: 'First title' });
		secondHost.emit({ res: { command: 'pr.update', pullrequest: { title: 'Second title' } } });
		assert.strictEqual(first.pr?.title, 'First title');
		assert.strictEqual(firstHost.getState<PullRequest>()?.title, 'First title');
		assert.strictEqual(second.pr?.title, 'Second title');
		assert.strictEqual(secondHost.getState<PullRequest>()?.title, 'Second title');
		firstHost.setState({ ...pr, pendingCommentText: 'Draft', pendingReviewSummaryText: 'Review draft' });
		first.setPR({ ...pr });
		assert.strictEqual(first.pr?.pendingCommentText, 'Draft');
		assert.strictEqual(first.pr?.pendingReviewSummaryText, 'Review draft');
		first.dispose();
		firstHost.emit({ res: { command: 'pr.update', pullrequest: { title: 'Late title' } } });
		assert.strictEqual(first.pr?.title, pr.title);
		second.dispose();
	});

	it('restores independent create state and keeps default arrays local to each instance', () => {
		const firstHost = new TestTransport();
		const secondHost = new TestTransport();
		const first = new CreatePRContextNew(createTestHost(undefined, firstHost));
		const second = new CreatePRContextNew(createTestHost(undefined, secondHost));
		assert.notStrictEqual(first.createParams.labels, second.createParams.labels);
		assert.notStrictEqual(first.createParams.assignees, second.createParams.assignees);
		assert.notStrictEqual(first.createParams.reviewers, second.createParams.reviewers);
		first.updateState({ pendingTitle: 'First draft' });
		second.updateState({ pendingTitle: 'Second draft' });
		const restored = new CreatePRContextNew(createTestHost(undefined, firstHost));
		assert.strictEqual(restored.createParams.pendingTitle, 'First draft');
		assert.strictEqual(secondHost.getState<CreateParamsNew>()?.pendingTitle, 'Second draft');
		first.dispose();
		second.dispose();
		restored.dispose();
	});

	it('preserves create persistence on failure and clears only the owning state on success', async () => {
		const firstHost = new TestTransport();
		const secondHost = new TestTransport();
		const first = new CreatePRContextNew(createTestHost(undefined, firstHost));
		const second = new CreatePRContextNew(createTestHost(undefined, secondHost));
		first.updateState({
			pendingTitle: 'First draft',
			baseRemote: { owner: 'owner', repositoryName: 'repo' },
			baseBranch: 'main',
			compareRemote: { owner: 'owner', repositoryName: 'repo' },
			compareBranch: 'feature'
		});
		second.updateState({ pendingTitle: 'Second draft' });
		const failed = first.submit();
		firstHost.emit({ seq: firstHost.messages[0].req, err: 'Create failed' });
		await failed;
		assert.strictEqual(firstHost.getState<CreateParamsNew>()?.pendingTitle, 'First draft');
		assert.strictEqual(first.createParams.createError, 'Create failed');
		const succeeded = first.submit();
		firstHost.reply(1, undefined);
		await succeeded;
		assert.strictEqual(firstHost.getState<CreateParamsNew>()?.pendingTitle, undefined);
		assert.strictEqual(secondHost.getState<CreateParamsNew>()?.pendingTitle, 'Second draft');
		first.dispose();
		second.dispose();
	});

	it('cleans up Root callbacks without disposing the supplied context', async () => {
		const { Root } = require('../../editorWebview/app') as typeof import('../../editorWebview/app');
		const transport = new TestTransport();
		const host = createTestHost(new PullRequestBuilder().build(), transport);
		const context = new PRContext(host);
		const root = render(React.createElement(PullRequestContext.Provider, { value: context },
			React.createElement(Root, { children: () => React.createElement('div') })));
		try {
			await wait(() => assert(context.onchange));
			root.unmount();
			await wait(() => {
				assert.strictEqual(context.onchange, null);
				assert.strictEqual(context.onPreviewChange, null);
				assert.strictEqual(transport.listeners.size, 1);
			});
			context.dispose();
			assert.strictEqual(transport.listeners.size, 1);
			host.dispose();
			assert.strictEqual(transport.listeners.size, 0);
		} finally {
			root.unmount();
			context.dispose();
		}
	});
});
