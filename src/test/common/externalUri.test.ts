/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import * as vscode from 'vscode';
import { parseGitHubIssueOrPullRequestUri } from '../../common/externalUri';

describe('externalUri', () => {
	describe('parseGitHubIssueOrPullRequestUri', () => {
		it('parses a GitHub pull request URL', () => {
			const result = parseGitHubIssueOrPullRequestUri(vscode.Uri.parse('https://github.com/microsoft/vscode/pull/123'));

			assert.deepStrictEqual(result, {
				kind: 'pullRequest',
				owner: 'microsoft',
				repo: 'vscode',
				number: 123,
			});
		});

		it('parses pull request subpages, queries, and fragments', () => {
			const result = parseGitHubIssueOrPullRequestUri(vscode.Uri.parse('https://github.com/microsoft/vscode/pull/123/files?diff=split#discussion_r1'));

			assert.deepStrictEqual(result, {
				kind: 'pullRequest',
				owner: 'microsoft',
				repo: 'vscode',
				number: 123,
			});
		});

		it('parses a GitHub issue URL', () => {
			const result = parseGitHubIssueOrPullRequestUri(vscode.Uri.parse('https://github.com/microsoft/vscode/issues/456#issuecomment-1'));

			assert.deepStrictEqual(result, {
				kind: 'issue',
				owner: 'microsoft',
				repo: 'vscode',
				number: 456,
			});
		});

		it('supports HTTP and case-insensitive GitHub hosts', () => {
			const result = parseGitHubIssueOrPullRequestUri(vscode.Uri.parse('http://GitHub.com/owner/repo_name/pull/1'));

			assert.deepStrictEqual(result, {
				kind: 'pullRequest',
				owner: 'owner',
				repo: 'repo_name',
				number: 1,
			});
		});

		for (const url of [
			'https://example.com/microsoft/vscode/pull/123',
			'https://github.com:443/microsoft/vscode/pull/123',
			'https://github.com/microsoft/vscode/issue/123',
			'https://github.com/microsoft/vscode/pulls/123',
			'https://github.com/microsoft/vscode/pull/0',
			'https://github.com/microsoft/vscode/pull/not-a-number',
			'https://github.com/microsoft/vscode/pull/999999999999999999999',
			'https://github.com/microsoft/vscode/pull/123.diff',
			'https://github.com/microsoft/vscode/pull',
		]) {
			it(`does not parse ${url}`, () => {
				assert.strictEqual(parseGitHubIssueOrPullRequestUri(vscode.Uri.parse(url)), undefined);
			});
		}
	});
});
