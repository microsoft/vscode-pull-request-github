/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import * as React from 'react';
import { cleanup, fireEvent, render } from 'react-testing-library';
import { createSandbox, SinonFakeTimers, SinonSandbox } from 'sinon';

import { PullRequestBuilder } from './builder/pullRequest';
import { CheckState, PullRequestCheckStatus, PullRequestMergeability } from '../../../src/github/interface';
import { PRContext, default as PullRequestContext } from '../../common/context';
import { Merge, MergeStatusAndActions, StatusChecksSection } from '../../components/merge';

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

describe('Status checks', function () {
	afterEach(function () {
		cleanup();
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
});
