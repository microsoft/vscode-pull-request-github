/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import * as React from 'react';
import { unmountComponentAtNode } from 'react-dom';
import { act, cleanup, fireEvent, render } from 'react-testing-library';
import { createSandbox, SinonSandbox } from 'sinon';
import { StackCandidate } from '../../../common/views';
import { CreatePRContextNew } from '../../common/createContextNew';
import { MessageHandler, vscode } from '../../common/message';
import { main, makeCreateMenuContext, StackOption } from '../app';

describe('Create pull request stack', function () {
	let sinon: SinonSandbox;
	let previousState: ReturnType<typeof vscode.getState>;
	const candidate: StackCandidate = { parentPullRequestNumber: 795, stackNumber: 12, size: 3, url: 'https://github.com/owner/repo/pull/795' };

	beforeEach(function () {
		sinon = createSandbox();
		previousState = vscode.getState();
		vscode.setState(undefined);
	});

	afterEach(function () {
		cleanup();
		const app = document.getElementById('app');
		if (app) {
			unmountComponentAtNode(app);
			app.remove();
		}
		CreatePRContextNew.instance.onchange = null;
		vscode.setState(previousState);
		sinon.restore();
	});

	it('shows the stack option unchecked with the parent and stack size', function () {
		const onChange = sinon.spy();
		const out = render(<StackOption candidate={candidate} checked={false} disabled={false} onChange={onChange} />);

		const checkbox = out.getByLabelText(/Add this pull request to a stack/) as HTMLInputElement;
		assert.strictEqual(checkbox.checked, false);
		assert(checkbox.parentElement?.classList.contains('checkbox-wrapper'));
		assert.strictEqual(out.container.querySelector('.stack-option-description')?.textContent,
			'This pull request will be stacked with #795 and 2 other pull requests.');
		const link = out.getByText('#795') as HTMLAnchorElement;
		assert.strictEqual(link.href, candidate.url);
		link.addEventListener('click', event => event.preventDefault());
		fireEvent.click(link);
		assert(onChange.notCalled);
		fireEvent.click(checkbox);
		assert(onChange.calledOnceWithExactly(true));
	});

	it('offers to create a new stack when the base PR is not already stacked', function () {
		const out = render(<StackOption candidate={{ parentPullRequestNumber: 795, size: 1, url: candidate.url }} checked={false} disabled={false} onChange={() => { }} />);

		assert(out.getByLabelText(/Create a stack with this pull request/));
		assert(out.getByText('#795'));
		assert.strictEqual(out.queryByText(/other pull requests/), null);
	});

	it('hides auto-merge menu choices only when adding to the stack', function () {
		const context = new CreatePRContextNew();
		const params = {
			...context.createParams,
			allowAutoMerge: true,
			baseHasMergeQueue: false,
			mergeMethodsAvailability: { merge: true, squash: true, rebase: true },
		};
		assert.strictEqual(JSON.parse(makeCreateMenuContext({ ...params, addToStack: false }))['github:createPrMenuSquash'], true);
		const stacked = JSON.parse(makeCreateMenuContext({ ...params, addToStack: true }));
		assert.strictEqual(stacked['github:createPrMenuDraft'], true);
		assert.strictEqual(stacked['github:createPrMenuSquash'], undefined);
		assert.strictEqual(JSON.parse(makeCreateMenuContext({ ...params, baseHasMergeQueue: true, addToStack: true }))['github:createPrMenuMergeWhenReady'], undefined);
	});

	it('updates the create button and menu when stacking is checked', function () {
		const app = document.createElement('div');
		app.id = 'app';
		document.body.appendChild(app);
		const context = CreatePRContextNew.instance;
		context.updateState({
			defaultBaseRemote: { owner: 'owner', repositoryName: 'repo' },
			defaultBaseBranch: 'D3',
			baseRemote: { owner: 'owner', repositoryName: 'repo' },
			baseBranch: 'D3',
			compareRemote: { owner: 'owner', repositoryName: 'repo' },
			compareBranch: 'D4',
			pendingTitle: 'Fourth change',
			pendingDescription: '',
			stackCandidate: candidate,
			allowAutoMerge: true,
			autoMerge: true,
			autoMergeMethod: 'squash',
			mergeMethodsAvailability: { merge: true, squash: true, rebase: true },
		}, true);
		act(() => { main(); });

		const checkbox = app.querySelector<HTMLInputElement>('.stack-option input');
		assert(checkbox);
		const primary = app.querySelector('.group-actions .split-left');
		const menu = app.querySelector('.group-actions .split-right');
		assert.strictEqual(primary?.textContent, 'Create + Auto-Squash');
		assert.strictEqual(JSON.parse(menu!.getAttribute('data-vscode-context')!)['github:createPrMenuSquash'], true);

		act(() => { fireEvent.click(checkbox); });

		assert.strictEqual(checkbox.checked, true);
		assert.strictEqual(primary?.textContent, 'Create');
		assert.strictEqual(JSON.parse(menu!.getAttribute('data-vscode-context')!)['github:createPrMenuSquash'], undefined);

		act(() => { fireEvent.click(checkbox); });
		assert.strictEqual(checkbox.checked, false);
		assert.strictEqual(JSON.parse(menu!.getAttribute('data-vscode-context')!)['github:createPrMenuSquash'], true);
	});

	it('submits a stack request without auto-merge even when it was previously selected', async function () {
		const handler = new MessageHandler(null);
		const postMessage = sinon.stub(handler, 'postMessage').resolves({});
		const context = new CreatePRContextNew(null, handler);
		context.updateState({
			baseRemote: { owner: 'owner', repositoryName: 'repo' },
			baseBranch: 'D3',
			compareRemote: { owner: 'owner', repositoryName: 'repo' },
			compareBranch: 'D4',
			pendingTitle: 'Fourth change',
			pendingDescription: '',
			stackCandidate: candidate,
			addToStack: true,
			autoMerge: true,
		});

		await context.submit();

		assert(postMessage.calledOnce);
		assert.strictEqual(postMessage.firstCall.args[0].args.addToStack, true);
		assert.strictEqual(postMessage.firstCall.args[0].args.stackParentPullRequest, 795);
		assert.strictEqual(postMessage.firstCall.args[0].args.stackNumber, 12);
		assert.strictEqual(postMessage.firstCall.args[0].args.autoMerge, false);
	});

	it('clears a checked stack option when the base branch changes', async function () {
		const handler = new MessageHandler(null);
		sinon.stub(handler, 'postMessage').resolves({
			baseRemote: { owner: 'owner', repositoryName: 'repo' },
			baseBranch: 'D2',
			stackCandidate: { parentPullRequestNumber: 794, size: 1, url: 'https://github.com/owner/repo/pull/794' },
		});
		const context = new CreatePRContextNew(null, handler);
		context.updateState({
			baseRemote: { owner: 'owner', repositoryName: 'repo' },
			baseBranch: 'D3',
			stackCandidate: candidate,
			addToStack: true,
		});

		await context.changeBaseRemoteAndBranch(context.createParams.baseRemote, 'D3');

		assert.strictEqual(context.createParams.baseBranch, 'D2');
		assert.strictEqual(context.createParams.addToStack, false);
		assert.strictEqual(context.createParams.stackCandidate?.parentPullRequestNumber, 794);
	});

	it('clears stack selection only when branch, repository or stack membership changes', async function () {
		const cases = [
			{ baseBranch: 'D2' },
			{ compareBranch: 'D5' },
			{ baseRemote: { owner: 'other', repositoryName: 'repo' } },
			{ compareRemote: { owner: 'owner', repositoryName: 'other' } },
			{ stackCandidate: undefined },
			{ stackCandidate: { ...candidate, stackNumber: 13 } },
		];
		for (const params of cases) {
			const context = new CreatePRContextNew();
			context.updateState({
				baseRemote: { owner: 'owner', repositoryName: 'repo' },
				compareRemote: { owner: 'owner', repositoryName: 'repo' },
				baseBranch: 'D3',
				compareBranch: 'D4',
				stackCandidate: candidate,
				addToStack: true,
			});
			await context.handleMessage({ command: 'pr.initialize', params });
			assert.strictEqual(context.createParams.addToStack, false);
		}

		const context = new CreatePRContextNew();
		context.updateState({ stackCandidate: candidate, addToStack: true });
		await context.handleMessage({ command: 'pr.initialize', params: { pendingTitle: 'Fourth change' } });
		assert.strictEqual(context.createParams.addToStack, true);
		await context.handleMessage({ command: 'pr.initialize', params: { stackCandidate: { ...candidate, url: 'https://example.com/795' } } });
		assert.strictEqual(context.createParams.addToStack, true);
	});

	it('keeps the selected branch and stack option when changing compare branches fails', async function () {
		const handler = new MessageHandler(null);
		sinon.stub(handler, 'postMessage').rejects(new Error('Branch does not exist locally.'));
		const context = new CreatePRContextNew(null, handler);
		context.updateState({
			compareRemote: { owner: 'owner', repositoryName: 'repo' },
			compareBranch: 'D4',
			stackCandidate: candidate,
			addToStack: true,
		});

		await context.changeMergeRemoteAndBranch(context.createParams.compareRemote, context.createParams.compareBranch);

		assert.strictEqual(context.createParams.compareBranch, 'D4');
		assert.strictEqual(context.createParams.addToStack, true);
		assert.strictEqual(context.createParams.warning, 'Branch does not exist locally.');
	});

	it('clears a stale branch warning after a successful selection of the same base branch', async function () {
		const handler = new MessageHandler(null);
		sinon.stub(handler, 'postMessage').resolves({
			baseRemote: { owner: 'owner', repositoryName: 'repo' },
			baseBranch: 'D3',
			stackCandidate: candidate,
			warning: undefined,
		});
		const context = new CreatePRContextNew(null, handler);
		context.updateState({
			baseRemote: { owner: 'owner', repositoryName: 'repo' },
			baseBranch: 'D3',
			stackCandidate: candidate,
			warning: 'Unable to change the base branch.',
		});

		await context.changeBaseRemoteAndBranch(context.createParams.baseRemote, 'D3');

		assert.strictEqual(context.createParams.warning, undefined);
	});

	it('replaces a stale compare-branch warning with the current server warning', async function () {
		const handler = new MessageHandler(null);
		sinon.stub(handler, 'postMessage').resolves({
			compareRemote: { owner: 'owner', repositoryName: 'repo' },
			compareBranch: 'D4',
			stackCandidate: candidate,
			warning: 'A pull request already exists for this branch.',
		});
		const context = new CreatePRContextNew(null, handler);
		context.updateState({
			compareRemote: { owner: 'owner', repositoryName: 'repo' },
			compareBranch: 'D4',
			warning: 'Unable to change the merge branch.',
		});

		await context.changeMergeRemoteAndBranch(context.createParams.compareRemote, 'D4');

		assert.strictEqual(context.createParams.warning, 'A pull request already exists for this branch.');
	});
});
