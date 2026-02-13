/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import { getPRFetchQuery, sanitizeIssueTitle, variableSubstitution } from '../../github/utils';
import { IssueModel } from '../../github/issueModel';
import { PullRequestDefaults } from '../../github/folderRepositoryManager';

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
		const defaults: PullRequestDefaults = {
			owner: 'testOwner',
			repo: 'testRepo',
			base: 'main'
		};

		it('replaces ${issueNumber} with issue number', () => {
			const issueModel = {
				number: 123,
				title: 'Test Issue',
				remote: { owner: 'testOwner', repositoryName: 'testRepo' }
			} as unknown as IssueModel;
			const result = variableSubstitution('Closes ${issueNumber}', issueModel, defaults, 'testUser');
			assert.strictEqual(result, 'Closes 123');
		});

		it('replaces ${issueNumberLabel} with #number for same repo', () => {
			const issueModel = {
				number: 456,
				title: 'Test Issue',
				remote: { owner: 'testOwner', repositoryName: 'testRepo' }
			} as unknown as IssueModel;
			const result = variableSubstitution('Fixes ${issueNumberLabel}', issueModel, defaults, 'testUser');
			assert.strictEqual(result, 'Fixes #456');
		});

		it('replaces ${issueNumberLabel} with owner/repo#number for different repo', () => {
			const issueModel = {
				number: 789,
				title: 'Test Issue',
				remote: { owner: 'otherOwner', repositoryName: 'otherRepo' }
			} as unknown as IssueModel;
			const result = variableSubstitution('Resolves ${issueNumberLabel}', issueModel, defaults, 'testUser');
			assert.strictEqual(result, 'Resolves otherOwner/otherRepo#789');
		});

		it('replaces ${issueTitle} with issue title', () => {
			const issueModel = {
				number: 123,
				title: 'Fix bug in parser',
				remote: { owner: 'testOwner', repositoryName: 'testRepo' }
			} as unknown as IssueModel;
			const result = variableSubstitution('Working on: ${issueTitle}', issueModel, defaults, 'testUser');
			assert.strictEqual(result, 'Working on: Fix bug in parser');
		});

		it('replaces ${user} with username', () => {
			const result = variableSubstitution('Assigned to ${user}', undefined, defaults, 'johnDoe');
			assert.strictEqual(result, 'Assigned to johnDoe');
		});

		it('replaces ${repository} with repo name', () => {
			const result = variableSubstitution('From ${repository}', undefined, defaults, 'testUser');
			assert.strictEqual(result, 'From testRepo');
		});

		it('replaces ${owner} with owner name', () => {
			const result = variableSubstitution('By ${owner}', undefined, defaults, 'testUser');
			assert.strictEqual(result, 'By testOwner');
		});

		it('replaces multiple variables in one string', () => {
			const issueModel = {
				number: 123,
				title: 'Test Issue',
				remote: { owner: 'testOwner', repositoryName: 'testRepo' }
			} as unknown as IssueModel;
			const result = variableSubstitution('Closes ${issueNumberLabel}: ${issueTitle}', issueModel, defaults, 'testUser');
			assert.strictEqual(result, 'Closes #123: Test Issue');
		});

		it('leaves variable unchanged if issue is not provided', () => {
			const result = variableSubstitution('Closes ${issueNumberLabel}', undefined, defaults, 'testUser');
			assert.strictEqual(result, 'Closes ${issueNumberLabel}');
		});

		it('handles empty string', () => {
			const result = variableSubstitution('', undefined, defaults, 'testUser');
			assert.strictEqual(result, '');
		});
	});
});