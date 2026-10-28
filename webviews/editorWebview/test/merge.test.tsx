/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import * as React from 'react';
import { cleanup, render } from 'react-testing-library';
import { createSandbox, SinonFakeTimers, SinonSandbox } from 'sinon';

import { PullRequestBuilder } from './builder/pullRequest';
import { PullRequestMergeability } from '../../../src/github/interface';
import { PRContext, default as PullRequestContext } from '../../common/context';
import { MergeStatusAndActions } from '../../components/merge';

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
});
