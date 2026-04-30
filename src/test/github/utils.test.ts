/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import { getPRFetchQuery, sanitizeIssueTitle, variableSubstitution } from '../../github/utils';
import { IssueModel } from '../../github/issueModel';

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

	describe('variableSubstitution', () => {
		function makeIssueModel(overrides: { title?: string; number?: number; issueType?: string } = {}): IssueModel {
			const number = overrides.number ?? 42;
			const title = overrides.title ?? 'Some Issue';
			return {
				number,
				title,
				item: {
					issueType: overrides.issueType,
				},
			} as unknown as IssueModel;
		}

		it('replaces ${issueType} with the issue type name', () => {
			const result = variableSubstitution('${issueType}-${issueNumber}', makeIssueModel({ issueType: 'Feature', number: 7 }));
			assert.strictEqual(result, 'Feature-7');
		});

		it('replaces ${sanitizedIssueType} with a branch-safe issue type', () => {
			const result = variableSubstitution('${sanitizedIssueType}-${issueNumber}', makeIssueModel({ issueType: 'Production Bug Fix', number: 7 }));
			assert.strictEqual(result, 'Production-Bug-Fix-7');
		});

		it('replaces ${sanitizedLowercaseIssueType} with a lowercase branch-safe issue type', () => {
			const result = variableSubstitution('${sanitizedLowercaseIssueType}-${issueNumber}', makeIssueModel({ issueType: 'Production Bug Fix', number: 7 }));
			assert.strictEqual(result, 'production-bug-fix-7');
		});

		it('leaves ${issueType} unsubstituted when the issue has no issue type', () => {
			const result = variableSubstitution('${issueType}-${issueNumber}', makeIssueModel({ issueType: undefined, number: 7 }));
			assert.strictEqual(result, '${issueType}-7');
		});
	});
});