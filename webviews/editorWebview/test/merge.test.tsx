/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import * as React from 'react';
import { cleanup, fireEvent, render, wait } from 'react-testing-library';
import { createSandbox, SinonFakeTimers, SinonSandbox } from 'sinon';

import { PullRequestBuilder } from './builder/pullRequest';
import { CheckState, GithubItemStateEnum, PullRequestCheckStatus, PullRequestMergeability } from '../../../src/github/interface';
import { MergeResult } from '../../../src/github/views';
import { PRContext, default as PullRequestContext } from '../../common/context';
import { Merge, MergeSimple, MergeStatusAndActions, StatusChecksSection } from '../../components/merge';

describe('Merge status and actions', function () {
	let sinon: SinonSandbox;
	let clock: SinonFakeTimers & { tickAsync(milliseconds: number): Promise<number> };

	beforeEach(function () {
		sinon = createSandbox();
		clock = sinon.useFakeTimers() as SinonFakeTimers & { tickAsync(milliseconds: number): Promise<number> };
	});

	afterEach(function () {
		cleanup();
		sinon.restore();
	});

	it('updates an unknown mergeability state from the polling response', async function () {
		const pr = new PullRequestBuilder()
			.mergeable(PullRequestMergeability.Unknown)
			.hasWritePermission(false)
			.build();
		const context = new PRContext(pr);
		const checkMergeability = sinon.stub(context, 'checkMergeability').resolves({
			mergeability: PullRequestMergeability.Mergeable,
		});

		const view = render(
			<PullRequestContext.Provider value={context}>
				<MergeStatusAndActions pr={pr} isSimple={true} />
			</PullRequestContext.Provider>,
		);

		assert(view.queryByText('Checking if this branch can be merged...'));

		await clock.tickAsync(3000);

		assert(view.queryByText('This branch has no conflicts with the base branch.'));
		assert.strictEqual(checkMergeability.calledOnce, true);

		await clock.tickAsync(3000);

		assert.strictEqual(checkMergeability.calledOnce, true);
	});

	it('defaults the merge commit title to the head branch with its owner and repository', function () {
		const pr = new PullRequestBuilder()
			.number(1234)
			.head('feature')
			.qualifiedHead('contributor/repo:feature')
			.build();

		const view = render(
			<PullRequestContext.Provider value={new PRContext(pr)}>
				<Merge {...pr} />
			</PullRequestContext.Provider>,
		);
		fireEvent.click(view.getByText('Merge Pull Request'));

		assert.strictEqual(view.container.querySelector<HTMLInputElement>('input[name="title"]')?.value, 'Merge pull request #1234 from contributor/repo:feature');
	});
});

describe('Merge dropdown', function () {
	let sinon: SinonSandbox;

	beforeEach(function () {
		sinon = createSandbox();
	});

	afterEach(function () {
		cleanup();
		sinon.restore();
	});

	it('dims the divider with the rest of the button while merging', async function () {
		const pr = new PullRequestBuilder().build();
		const context = new PRContext(pr);
		let finish!: (result: MergeResult) => void;
		sinon.stub(context, 'merge').returns(new Promise<MergeResult>(resolve => { finish = resolve; }));
		const view = render(
			<PullRequestContext.Provider value={context}>
				<MergeSimple {...pr} />
			</PullRequestContext.Provider>,
		);
		const submit = view.container.querySelector<HTMLInputElement>('.select-control input[type="submit"]')!;
		const divider = view.container.querySelector('.select-control .split')!;

		fireEvent.submit(submit.form!);
		assert.strictEqual(submit.value, 'Merging...');
		assert.strictEqual(submit.disabled, true);
		assert.strictEqual(divider.classList.contains('disabled'), true);

		// The merge was not confirmed, so the pull request stays open.
		finish({ state: GithubItemStateEnum.Open, revertable: false });
		await wait(() => assert.strictEqual(submit.disabled, false));
		assert.strictEqual(divider.classList.contains('disabled'), false);
	});
});

describe('Status checks', function () {
	let sinon: SinonSandbox;

	beforeEach(function () {
		sinon = createSandbox();
	});

	afterEach(function () {
		cleanup();
		sinon.restore();
	});

	function check(context: string, state: CheckState, isRequired: boolean): PullRequestCheckStatus {
		return {
			id: context,
			databaseId: undefined,
			url: undefined,
			avatarUrl: undefined,
			state,
			description: null,
			targetUrl: null,
			context,
			workflowName: undefined,
			event: undefined,
			isRequired,
			isCheckRun: false,
		};
	}

	it('lists required checks first, each group ordered by state', function () {
		const pr = new PullRequestBuilder()
			.status(s => s
				.state(CheckState.Failure)
				.statuses([
					check('optional-success', CheckState.Success, false),
					check('required-success', CheckState.Success, true),
					check('optional-failure', CheckState.Failure, false),
					check('required-pending', CheckState.Pending, true),
					check('optional-pending', CheckState.Pending, false),
					check('required-failure', CheckState.Failure, true),
				]))
			.build();

		const view = render(
			<PullRequestContext.Provider value={new PRContext(pr)}>
				<StatusChecksSection pr={pr} isSimple={false} />
			</PullRequestContext.Provider>,
		);

		const listed = Array.from(view.container.querySelectorAll('.status-check-detail-text')).map(e => e.textContent?.trim());
		assert.deepStrictEqual(listed, [
			'required-failure',
			'required-pending',
			'required-success',
			'optional-failure',
			'optional-pending',
			'optional-success',
		]);
	});

	it('shows the logs of each failed check opening until they are open', async function () {
		const failed = (context: string, databaseId: number) => ({ ...check(context, CheckState.Failure, false), isCheckRun: true, databaseId });
		const pr = new PullRequestBuilder()
			.status(s => s.state(CheckState.Failure).statuses([failed('first', 1), failed('second', 2)]))
			.build();
		const context = new PRContext(pr);
		const opened = new Map<string, () => void>();
		sinon.stub(context, 'viewCheckLogs').callsFake(status => new Promise<void>(resolve => opened.set(status.context, resolve)));
		const view = render(
			<PullRequestContext.Provider value={context}>
				<StatusChecksSection pr={pr} isSimple={false} />
			</PullRequestContext.Provider>,
		);
		const [first, second] = view.getAllByTitle('View Logs') as HTMLButtonElement[];

		fireEvent.click(first);
		fireEvent.click(second);
		assert.deepStrictEqual([first.title, first.disabled, second.title, second.disabled], ['Opening Logs...', true, 'Opening Logs...', true]);

		opened.get('first')!();
		await wait(() => assert.strictEqual(first.disabled, false));
		assert.deepStrictEqual([first.title, second.title, second.disabled], ['View Logs', 'Opening Logs...', true]);
	});
});
