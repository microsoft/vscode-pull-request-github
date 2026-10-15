/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as React from 'react';
import { cleanup, fireEvent, render } from 'react-testing-library';
import { createSandbox } from 'sinon';
import { GithubItemStateEnum, PullRequestMergeability } from '../../../src/github/interface';
import { createTestHost } from '../../../src/test/webviews/testHost';
import PullRequestContext, { PRContext } from '../../common/context';
import { PullRequestBuilder } from '../../editorWebview/test/builder/pullRequest';
import { StackSection } from '../pullRequestStack';

describe('Stack action disposal', () => {
	afterEach(cleanup);

	for (const action of ['Update stack', 'Unstack all']) {
		it(`does not update an unmounted component when ${action} rejects`, async () => {
			const sandbox = createSandbox();
			const pr = new PullRequestBuilder().stack({
				position: 1, size: 1, base: 'main',
				pullRequests: [{
					position: 1, number: 1234, title: 'First', head: 'D1', url: 'https://example.com/1234',
					state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Mergeable,
				}],
			}).build();
			pr.hasWritePermission = true;
			pr.canUpdateStack = true;
			const host = createTestHost(pr);
			const context = new PRContext(host);
			let rejectPending!: (error: Error) => void;
			const pending = new Promise<never>((_, reject) => { rejectPending = reject; });
			const request = sandbox.stub(host, 'postMessage').returns(pending);
			const errors = sandbox.stub(console, 'error');
			const out = render(<PullRequestContext.Provider value={context}>
				<StackSection pr={pr} />
			</PullRequestContext.Provider>);
			try {
				fireEvent.click(out.getByText(action));
				assert.strictEqual(request.callCount, 1);
				out.unmount();
				rejectPending(new Error('Host disposed'));
				await new Promise<void>(resolve => setTimeout(resolve, 0));
				assert.deepStrictEqual(errors.args, []);
			} finally {
				out.unmount();
				context.dispose();
				sandbox.restore();
			}
		});
	}
});
