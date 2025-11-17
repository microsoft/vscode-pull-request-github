/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import { getPRFetchQuery, sanitizeIssueTitle, getAvatarWithEnterpriseFallback } from '../../github/utils';

describe('utils', () => {

	describe('getPRFetchQuery', () => {
		it('replaces all instances of ${user}', () => {
			const user = 'rmacfarlane';
			const query = 'reviewed-by:${user} -author:${user}';
			const result = getPRFetchQuery(user, query)
			assert.strictEqual(result, 'is:pull-request reviewed-by:rmacfarlane -author:rmacfarlane type:pr');
		});
	});

	describe('sanitizeIssueTitle', () => {
		[
			{ input: 'Issue', expected: 'Issue' },
			{ input: 'Issue A', expected: 'Issue-A' },
			{ input: 'Issue  A', expected: 'Issue-A' },
			{ input: 'Issue     A', expected: 'Issue-A' },
			{ input: 'Issue @ A', expected: 'Issue-A' },
			{ input: "Issue 'A'", expected: 'Issue-A' },
			{ input: 'Issue "A"', expected: 'Issue-A' },
			{ input: '@Issue "A"', expected: 'Issue-A' },
			{ input: 'Issue "A"%', expected: 'Issue-A' },
			{ input: 'Issue .A', expected: 'Issue-A' },
			{ input: 'Issue ,A', expected: 'Issue-A' },
			{ input: 'Issue :A', expected: 'Issue-A' },
			{ input: 'Issue ;A', expected: 'Issue-A' },
			{ input: 'Issue ~A', expected: 'Issue-A' },
			{ input: 'Issue #A', expected: 'Issue-A' },
		].forEach(testCase => {
			it(`Transforms '${testCase.input}' into '${testCase.expected}'`, () => {
				const actual = sanitizeIssueTitle(testCase.input);
				assert.strictEqual(actual, testCase.expected);
			});
		});
	});

	describe('getAvatarWithEnterpriseFallback', () => {
		it('returns avatarUrl for non-enterprise when provided', () => {
			const avatarUrl = 'https://avatars.githubusercontent.com/u/12345';
			const result = getAvatarWithEnterpriseFallback(avatarUrl, undefined, false);
			assert.strictEqual(result, avatarUrl);
		});

		it('returns avatarUrl for enterprise when avatarUrl is provided', () => {
			const avatarUrl = 'https://enterprise.github.com/avatars/u/12345';
			const result = getAvatarWithEnterpriseFallback(avatarUrl, 'user@example.com', true);
			assert.strictEqual(result, avatarUrl);
		});

		it('returns Gravatar URL for enterprise when avatarUrl is empty and email is provided', () => {
			const email = 'user@example.com';
			const result = getAvatarWithEnterpriseFallback('', email, true);
			assert.ok(result);
			assert.ok(result!.startsWith('https://www.gravatar.com/avatar/'));
			assert.ok(result!.includes('s=200')); // default size
			assert.ok(result!.includes('d=retro')); // default style
		});

		it('returns undefined for enterprise when both avatarUrl and email are empty', () => {
			const result = getAvatarWithEnterpriseFallback('', undefined, true);
			assert.strictEqual(result, undefined);
		});

		it('returns avatarUrl for enterprise when avatarUrl has only whitespace', () => {
			const result = getAvatarWithEnterpriseFallback('   ', 'user@example.com', true);
			assert.strictEqual(result, undefined);
		});

		it('generates consistent Gravatar hash for same email', () => {
			const email = 'test@example.com';
			const result1 = getAvatarWithEnterpriseFallback('', email, true);
			const result2 = getAvatarWithEnterpriseFallback('', email, true);
			assert.strictEqual(result1, result2);
		});
	});
});