/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import { getPullRequestQuickPickItem } from '../../github/pullRequestQuickPick';

describe('QuickPicks', () => {
	it('separates pull request numbers from titles to prioritize exact number matches', () => {
		const item = getPullRequestQuickPickItem({
			number: 10063,
			title: 'upgrade library to v5',
			author: { login: 'octocat' },
		});

		assert.deepStrictEqual(item, {
			label: '#10063',
			description: 'upgrade library to v5 by @octocat',
			prNumber: 10063,
		});
	});
});
