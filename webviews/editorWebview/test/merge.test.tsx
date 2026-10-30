/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import * as React from 'react';
import { act, cleanup, fireEvent, render, wait } from 'react-testing-library';
import { createSandbox, SinonFakeTimers, SinonSandbox } from 'sinon';

import { PullRequestBuilder } from './builder/pullRequest';
import { GithubItemStateEnum, MergeQueueState, PullRequestMergeability } from '../../../src/github/interface';
import { PullRequest } from '../../../src/github/views';
import { PRContext, default as PullRequestContext } from '../../common/context';
import { MergeStatusAndActions, PrActions } from '../../components/merge';

describe('Merge status and actions', function () {
	let sinon: SinonSandbox;
	let clock: SinonFakeTimers & { tickAsync(milliseconds: number): Promise<number> };

	beforeEach(function () {
		sinon = createSandbox();
	});

	afterEach(function () {
		cleanup();
		sinon.restore();
	});

	const bypassLabel = 'Bypass branch protection and merge';
	const blockedPR = () => new PullRequestBuilder()
		.mergeable(PullRequestMergeability.NotMergeable).viewerCanMergeAsAdmin(true).build();

	[false, true].forEach(isSimple => [PullRequestMergeability.NotMergeable, PullRequestMergeability.Behind].forEach(mergeable => {
		it(`requires explicit, reversible bypass consent in the ${isSimple ? 'sidebar' : 'editor'} for ${PullRequestMergeability[mergeable]}`, function () {
			const pr = { ...blockedPR(), mergeable };
			const context = new PRContext(pr);
			const merge = sinon.stub(context, 'merge').resolves({ state: GithubItemStateEnum.Merged, revertable: true });
			const view = render(<PullRequestContext.Provider value={context}><PrActions pr={pr} isSimple={isSimple} /></PullRequestContext.Provider>);
			const checkbox = view.getByLabelText(bypassLabel) as HTMLInputElement;
			assert.strictEqual(checkbox.checked, false);
			assert.strictEqual(view.container.querySelector('button'), null);
			fireEvent.click(checkbox);
			assert.strictEqual(checkbox.checked, true);
			assert(view.container.querySelector('button'));
			assert.strictEqual(merge.called, false, 'opting in must not merge');
			fireEvent.click(checkbox);
			assert.strictEqual(view.container.querySelector('button'), null);
		});
	}));

	it('waits for queue requirements before offering bypass on an unstacked PR', function () {
		const pr = { ...blockedPR(), stack: null, stackLoaded: false };
		const context = new PRContext(pr);
		const content = (value: PullRequest) => <PullRequestContext.Provider value={context}><PrActions pr={value} isSimple={false} /></PullRequestContext.Provider>;
		const view = render(content(pr));
		assert.strictEqual(view.queryByLabelText(bypassLabel), null);
		view.rerender(content({ ...pr, stackLoaded: true, mergeQueueMethod: 'squash' }));
		assert.strictEqual(view.queryByLabelText(bypassLabel), null);
		view.rerender(content({ ...pr, stackLoaded: true }));
		assert.strictEqual((view.getByLabelText(bypassLabel) as HTMLInputElement).checked, false);
	});

	it('preserves the context receiver when updating auto-merge before bypass consent', async function () {
		const pr = { ...blockedPR(), allowAutoMerge: true, autoMerge: false };
		const context = new PRContext(pr);
		const postMessage = sinon.stub(context, 'postMessage').resolves({ autoMerge: true, autoMergeMethod: 'merge' });
		const view = render(<PullRequestContext.Provider value={context}><PrActions pr={pr} isSimple={false} /></PullRequestContext.Provider>);
		fireEvent.click(view.getByLabelText('Auto-merge'));
		await new Promise(resolve => setTimeout(resolve, 50));
		assert.strictEqual(postMessage.callCount, 1);
		assert.strictEqual(context.pr.autoMerge, true);
		assert.deepStrictEqual(postMessage.firstCall.args[0], {
			command: 'pr.update-automerge', args: { autoMerge: true, autoMergeMethod: 'merge' },
		});
		view.unmount();
		const methodView = render(<PullRequestContext.Provider value={context}><PrActions pr={context.pr} isSimple={false} /></PullRequestContext.Provider>);
		fireEvent.change(methodView.getByLabelText('Select merge method'), { target: { value: 'squash' } });
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.deepStrictEqual(postMessage.secondCall.args[0], {
			command: 'pr.update-automerge', args: { autoMerge: undefined, autoMergeMethod: 'squash' },
		});
		assert.strictEqual((methodView.getByLabelText(bypassLabel) as HTMLInputElement).checked, false);
	});

	it('uses the normal confirmation and merge request after opting in', async function () {
		const pr = blockedPR();
		const context = new PRContext(pr);
		const merge = sinon.stub(context, 'merge').resolves({ state: GithubItemStateEnum.Merged, revertable: true });
		const view = render(<PullRequestContext.Provider value={context}><PrActions pr={pr} isSimple={false} /></PullRequestContext.Provider>);
		fireEvent.click(view.getByLabelText(bypassLabel));
		fireEvent.click(view.getByText('Merge Pull Request'));
		assert.strictEqual(merge.called, false);
		fireEvent.submit(view.container.querySelector('form')!);
		await Promise.resolve();
		assert.strictEqual(merge.calledOnce, true);
		assert.strictEqual(merge.firstCall.args[0].method, 'merge');
		assert.strictEqual(merge.firstCall.args[0].email, pr.emailForCommit);
	});

	const guards: [string, Partial<PullRequest>][] = [
		['write permission without bypass capability', { viewerCanMergeAsAdmin: false }],
		['missing capability', { viewerCanMergeAsAdmin: undefined }],
		['no write permission', { hasWritePermission: false }],
		['conflicts', { mergeable: PullRequestMergeability.Conflict }],
		['unknown mergeability', { mergeable: PullRequestMergeability.Unknown }],
		['behind branch without bypass capability', { mergeable: PullRequestMergeability.Behind, viewerCanMergeAsAdmin: false }],
		['behind branch with missing capability', { mergeable: PullRequestMergeability.Behind, viewerCanMergeAsAdmin: undefined }],
		['draft', { isDraft: true }],
		['closed', { state: GithubItemStateEnum.Closed }],
		['merged', { state: GithubItemStateEnum.Merged }],
		['unknown stack membership', { stack: undefined, stackLoaded: false }],
		['queue requirements still loading for an unstacked PR', { stack: null, stackLoaded: false, mergeQueueMethod: undefined }],
		['stack load failure', { stackLoadError: true }],
		['stack', { stack: { position: 1, size: 1, base: 'main', pullRequests: [] } }],
		['pending stack merge', { stackMergeStatus: 'pending' }],
		['merge queue', { mergeQueueMethod: 'squash' }],
		['queued PR', { mergeQueueEntry: { url: '', position: 1, state: MergeQueueState.Queued } }],
	];
	for (const [name, change] of guards) {
		it(`does not offer bypass for ${name}`, function () {
			const pr = { ...blockedPR(), ...change };
			const view = render(<PullRequestContext.Provider value={new PRContext(pr)}><PrActions pr={pr} isSimple={false} /></PullRequestContext.Provider>);
			assert.strictEqual(view.queryByLabelText(bypassLabel), null);
			assert.strictEqual(view.queryByText('Merge Pull Request'), null);
		});
	}

	it('discards consent after losing capability or changing PR identity', function () {
		const pr = blockedPR();
		const context = new PRContext(pr);
		const content = (value: PullRequest) => <PullRequestContext.Provider value={context}><PrActions pr={value} isSimple={false} /></PullRequestContext.Provider>;
		const view = render(content(pr));
		fireEvent.click(view.getByLabelText(bypassLabel));
		view.rerender(content({ ...pr, viewerCanMergeAsAdmin: false }));
		assert.strictEqual(view.queryByText('Merge Pull Request'), null);
		view.rerender(content(pr));
		assert.strictEqual((view.getByLabelText(bypassLabel) as HTMLInputElement).checked, false);
		fireEvent.click(view.getByLabelText(bypassLabel));
		view.rerender(content({ ...pr, url: 'https://github.com/owner/repo/pull/2' }));
		assert.strictEqual((view.getByLabelText(bypassLabel) as HTMLInputElement).checked, false);
	});

	it('keeps normal merges unchanged and without a bypass checkbox', function () {
		const pr = new PullRequestBuilder().viewerCanMergeAsAdmin(true).build();
		const view = render(<PullRequestContext.Provider value={new PRContext(pr)}><PrActions pr={pr} isSimple={false} /></PullRequestContext.Provider>);
		assert(view.getByText('Merge Pull Request'));
		assert.strictEqual(view.queryByLabelText(bypassLabel), null);
	});

	it('offers bypass when polling reports a blocked PR and authorized viewer', async function () {
		clock = sinon.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }) as typeof clock;
		const interval = sinon.spy(global, 'setInterval');
		const pr = new PullRequestBuilder().mergeable(PullRequestMergeability.Unknown).build();
		const context = new PRContext(pr);
		sinon.stub(context, 'checkMergeability').resolves({
			mergeability: PullRequestMergeability.NotMergeable,
			viewerCanMergeAsAdmin: true,
		});
		let view: ReturnType<typeof render>;
		act(() => {
			view = render(<PullRequestContext.Provider value={context}><MergeStatusAndActions pr={pr} isSimple={false} /></PullRequestContext.Provider>);
		});
		await wait(() => assert(interval.called));
		await clock.tickAsync(3000);
		assert.strictEqual((view.getByLabelText(bypassLabel) as HTMLInputElement).checked, false);
		assert.strictEqual(view.queryByText('Merge Pull Request'), null);
	});

	it('resets consent and resumes polling on known-to-Unknown and repeated Unknown refreshes', async function () {
		clock = sinon.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }) as typeof clock;
		const interval = sinon.spy(global, 'setInterval');
		const pr = blockedPR();
		const context = new PRContext(pr);
		const poll = sinon.stub(context, 'checkMergeability').resolves({
			mergeability: PullRequestMergeability.Behind, viewerCanMergeAsAdmin: true,
		});
		const content = (value: PullRequest) => <PullRequestContext.Provider value={context}><MergeStatusAndActions pr={value} isSimple={false} /></PullRequestContext.Provider>;
		const view = render(content(pr));
		fireEvent.click(view.getByLabelText(bypassLabel));
		assert(view.getByText('Merge Pull Request'));

		for (let refresh = 0; refresh < 2; refresh++) {
			const unknown = { ...pr, mergeable: PullRequestMergeability.Unknown };
			act(() => { view.rerender(content(unknown)); });
			assert(view.getByText('Checking if this branch can be merged...'));
			assert.strictEqual(view.queryByLabelText(bypassLabel), null);
			assert.strictEqual(view.queryByText('Merge Pull Request'), null);
			await wait(() => assert.strictEqual(interval.callCount, refresh + 1));
			await clock.tickAsync(3000);
			assert.strictEqual(poll.callCount, refresh + 1);
			assert.strictEqual((view.getByLabelText(bypassLabel) as HTMLInputElement).checked, false);
			fireEvent.click(view.getByLabelText(bypassLabel));
			assert(view.getByText('Merge Pull Request'));
		}

		// Revocation while the incoming mergeability is still Unknown must also
		// discard the authorized polling result, even though that prop did not change.
		poll.resolves({ mergeability: PullRequestMergeability.Behind, viewerCanMergeAsAdmin: false });
		act(() => { view.rerender(content({ ...pr, mergeable: PullRequestMergeability.Unknown, viewerCanMergeAsAdmin: false })); });
		assert.strictEqual(view.queryByLabelText(bypassLabel), null);
		assert.strictEqual(view.queryByText('Merge Pull Request'), null);
		await wait(() => assert.strictEqual(interval.callCount, 3));
		await clock.tickAsync(3000);
		assert.strictEqual(poll.callCount, 3);
		assert.strictEqual(view.queryByLabelText(bypassLabel), null);
		assert.strictEqual(view.queryByText('Merge Pull Request'), null);
		view.rerender(content({ ...pr, mergeable: PullRequestMergeability.Behind }));
		assert.strictEqual((view.getByLabelText(bypassLabel) as HTMLInputElement).checked, false);
	});

	it('ignores an in-flight polling response after capability revocation', async function () {
		clock = sinon.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }) as typeof clock;
		const interval = sinon.spy(global, 'setInterval');
		const pr = { ...blockedPR(), mergeable: PullRequestMergeability.Unknown };
		const context = new PRContext(pr);
		let finish: (value: { mergeability: PullRequestMergeability; viewerCanMergeAsAdmin: boolean }) => void;
		const poll = sinon.stub(context, 'checkMergeability').returns(new Promise(resolve => { finish = resolve; }));
		const content = (value: PullRequest) => <PullRequestContext.Provider value={context}><MergeStatusAndActions pr={value} isSimple={false} /></PullRequestContext.Provider>;
		const view = render(content(pr));
		await wait(() => assert(interval.called));
		await clock.tickAsync(3000);
		assert(poll.calledOnce);
		view.rerender(content({ ...pr, mergeable: PullRequestMergeability.NotMergeable, viewerCanMergeAsAdmin: false }));
		finish({ mergeability: PullRequestMergeability.NotMergeable, viewerCanMergeAsAdmin: true });
		await Promise.resolve();
		assert.strictEqual(view.queryByLabelText(bypassLabel), null);
		assert.strictEqual(view.queryByText('Merge Pull Request'), null);
	});

	it('updates an unknown mergeability state from the polling response', async function () {
		clock = sinon.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }) as typeof clock;
		const interval = sinon.spy(global, 'setInterval');
		const pr = new PullRequestBuilder()
			.mergeable(PullRequestMergeability.Unknown)
			.hasWritePermission(false)
			.build();
		const context = new PRContext(pr);
		const checkMergeability = sinon.stub(context, 'checkMergeability').resolves({
			mergeability: PullRequestMergeability.Mergeable,
		});

		let view: ReturnType<typeof render>;
		act(() => {
			view = render(
				<PullRequestContext.Provider value={context}>
					<MergeStatusAndActions pr={pr} isSimple={true} />
				</PullRequestContext.Provider>,
			);
		});

		assert(view.queryByText('Checking if this branch can be merged...'));
		await wait(() => assert(interval.called));

		await clock.tickAsync(3000);

		assert(view.queryByText('This branch has no conflicts with the base branch.'));
		assert.strictEqual(checkMergeability.calledOnce, true);

		await clock.tickAsync(3000);

		assert.strictEqual(checkMergeability.calledOnce, true);
	});
});
