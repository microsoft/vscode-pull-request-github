/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import { migrateAddRepoScope } from '../migrations';

describe('migrations', function () {
	describe('migrateAddRepoScope', function () {
		it('adds repo: scope to queries that lack it', function () {
			const result = migrateAddRepoScope([{ label: 'My Query', query: 'is:open' }]);
			assert.strictEqual(result[0].query, 'repo:${owner}/${repository} is:open');
		});

		it('leaves queries that already have repo: scope unchanged', function () {
			const result = migrateAddRepoScope([{ label: 'My Query', query: 'repo:owner/repo is:open' }]);
			assert.strictEqual(result[0].query, 'repo:owner/repo is:open');
		});

		it('preserves groupBy when adding repo: scope', function () {
			const result = migrateAddRepoScope([{ label: 'Grouped', query: 'is:open', groupBy: ['milestone'] }]);
			assert.deepStrictEqual(result[0].groupBy, ['milestone']);
			assert.ok(result[0].query.startsWith('repo:'));
		});

		it('preserves groupBy when query already has repo: scope', function () {
			const result = migrateAddRepoScope([{ label: 'Grouped', query: 'repo:owner/repo is:open', groupBy: ['repository'] }]);
			assert.deepStrictEqual(result[0].groupBy, ['repository']);
			assert.strictEqual(result[0].query, 'repo:owner/repo is:open');
		});

		it('passes local queries through unchanged', function () {
			const q = { label: 'Local Pull Request Branches', query: 'default' };
			const result = migrateAddRepoScope([q]);
			assert.strictEqual(result[0], q);
		});

		it('passes all-open queries through unchanged', function () {
			const q = { label: 'All Open', query: 'default' };
			const result = migrateAddRepoScope([q]);
			assert.strictEqual(result[0], q);
		});
	});
});
