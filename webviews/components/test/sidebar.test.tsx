/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as React from 'react';
import { cleanup, render } from 'react-testing-library';
import { createSandbox } from 'sinon';
import { createTestHost } from '../../../src/test/webviews/testHost';
import PullRequestContext, { PRContext } from '../../common/context';
import { AccountBuilder } from '../../editorWebview/test/builder/account';
import { PullRequestBuilder } from '../../editorWebview/test/builder/pullRequest';
import { CollapsibleSidebar } from '../sidebar';

describe('Collapsed sidebar avatars', () => {
	afterEach(cleanup);

	it('renders accounts with shared names and avatars without duplicate or missing keys', () => {
		const sandbox = createSandbox();
		const error = sandbox.spy(console, 'error');
		const assignees = ['first', 'second'].map(id => new AccountBuilder().id(id).build());
		const pr = new PullRequestBuilder().assignees(assignees).build();
		const context = new PRContext(createTestHost(pr));
		try {
			const out = render(<PullRequestContext.Provider value={context}>
				<CollapsibleSidebar {...pr} />
			</PullRequestContext.Provider>);
			assert.strictEqual(out.container.querySelectorAll('.stacked-avatar').length, 2);
			assert(!error.args.some(args => String(args[0]).includes('key')));
		} finally {
			context.dispose();
			sandbox.restore();
		}
	});
});
