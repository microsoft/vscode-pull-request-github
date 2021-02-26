/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import { getPRFetchQuery } from '../../github/utils';

describe('utils', () => {

	describe('getPRFetchQuery', () => {
		it('replaces all instances of ${user}', () => {
			const repo = 'microsoft/vscode-pull-request-github';
			const user = 'rmacfarlane';
			const query = 'reviewed-by:${user} -author:${user}';
			const result = getPRFetchQuery(repo, user, query)
			assert.strictEqual(result, 'is:pull-request reviewed-by:rmacfarlane -author:rmacfarlane type:pr repo:microsoft/vscode-pull-request-github');
		});
	});
});