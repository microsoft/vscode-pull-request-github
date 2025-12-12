/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import * as vscode from 'vscode';
import { convertIssuePRReferencesToLinks, fromOpenOrCheckoutPullRequestWebviewUri } from '../../common/uri';

describe('uri', () => {
	describe('fromOpenOrCheckoutPullRequestWebviewUri', () => {
		it('should parse the new simplified format with uri parameter', () => {
			const uri = vscode.Uri.parse('vscode://github.vscode-pull-request-github/checkout-pull-request?uri=https://github.com/microsoft/vscode-css-languageservice/pull/460');
			const result = fromOpenOrCheckoutPullRequestWebviewUri(uri);

			assert.strictEqual(result?.owner, 'microsoft');
			assert.strictEqual(result?.repo, 'vscode-css-languageservice');
			assert.strictEqual(result?.pullRequestNumber, 460);
		});

		it('should parse the new simplified format with http (not https)', () => {
			const uri = vscode.Uri.parse('vscode://github.vscode-pull-request-github/checkout-pull-request?uri=http://github.com/owner/repo/pull/123');
			const result = fromOpenOrCheckoutPullRequestWebviewUri(uri);

			assert.strictEqual(result?.owner, 'owner');
			assert.strictEqual(result?.repo, 'repo');
			assert.strictEqual(result?.pullRequestNumber, 123);
		});

		it('should parse the old JSON format for backward compatibility', () => {
			const uri = vscode.Uri.parse('vscode://github.vscode-pull-request-github/checkout-pull-request?%7B%22owner%22%3A%22microsoft%22%2C%22repo%22%3A%22vscode-css-languageservice%22%2C%22pullRequestNumber%22%3A460%7D');
			const result = fromOpenOrCheckoutPullRequestWebviewUri(uri);

			assert.strictEqual(result?.owner, 'microsoft');
			assert.strictEqual(result?.repo, 'vscode-css-languageservice');
			assert.strictEqual(result?.pullRequestNumber, 460);
		});

		it('should work for open-pull-request-webview path', () => {
			const uri = vscode.Uri.parse('vscode://github.vscode-pull-request-github/open-pull-request-webview?uri=https://github.com/test/example/pull/789');
			const result = fromOpenOrCheckoutPullRequestWebviewUri(uri);

			assert.strictEqual(result?.owner, 'test');
			assert.strictEqual(result?.repo, 'example');
			assert.strictEqual(result?.pullRequestNumber, 789);
		});

		it('should return undefined for invalid authority', () => {
			const uri = vscode.Uri.parse('vscode://invalid-authority/checkout-pull-request?uri=https://github.com/owner/repo/pull/1');
			const result = fromOpenOrCheckoutPullRequestWebviewUri(uri);

			assert.strictEqual(result, undefined);
		});

		it('should return undefined for invalid path', () => {
			const uri = vscode.Uri.parse('vscode://github.vscode-pull-request-github/invalid-path?uri=https://github.com/owner/repo/pull/1');
			const result = fromOpenOrCheckoutPullRequestWebviewUri(uri);

			assert.strictEqual(result, undefined);
		});

		it('should return undefined for invalid GitHub URL format', () => {
			const uri = vscode.Uri.parse('vscode://github.vscode-pull-request-github/checkout-pull-request?uri=https://example.com/owner/repo/pull/1');
			const result = fromOpenOrCheckoutPullRequestWebviewUri(uri);

			assert.strictEqual(result, undefined);
		});

		it('should return undefined for non-numeric pull request number', () => {
			const uri = vscode.Uri.parse('vscode://github.vscode-pull-request-github/checkout-pull-request?uri=https://github.com/owner/repo/pull/abc');
			const result = fromOpenOrCheckoutPullRequestWebviewUri(uri);

			assert.strictEqual(result, undefined);
		});

		it('should handle repos with dots and dashes', () => {
			const uri = vscode.Uri.parse('vscode://github.vscode-pull-request-github/checkout-pull-request?uri=https://github.com/my-org/my.awesome-repo/pull/42');
			const result = fromOpenOrCheckoutPullRequestWebviewUri(uri);

			assert.strictEqual(result?.owner, 'my-org');
			assert.strictEqual(result?.repo, 'my.awesome-repo');
			assert.strictEqual(result?.pullRequestNumber, 42);
		});

		it('should handle repos with underscores', () => {
			const uri = vscode.Uri.parse('vscode://github.vscode-pull-request-github/checkout-pull-request?uri=https://github.com/owner/repo_name/pull/1');
			const result = fromOpenOrCheckoutPullRequestWebviewUri(uri);

			assert.strictEqual(result?.owner, 'owner');
			assert.strictEqual(result?.repo, 'repo_name');
			assert.strictEqual(result?.pullRequestNumber, 1);
		});

		it('should validate owner and repo names', () => {
			// Invalid owner (empty)
			const uri1 = vscode.Uri.parse('vscode://github.vscode-pull-request-github/checkout-pull-request?uri=https://github.com//repo/pull/1');
			const result1 = fromOpenOrCheckoutPullRequestWebviewUri(uri1);
			assert.strictEqual(result1, undefined);
		});

		it('should reject URLs with extra path segments after PR number', () => {
			// URL with /files suffix should be rejected
			const uri1 = vscode.Uri.parse('vscode://github.vscode-pull-request-github/checkout-pull-request?uri=https://github.com/owner/repo/pull/123/files');
			const result1 = fromOpenOrCheckoutPullRequestWebviewUri(uri1);
			assert.strictEqual(result1, undefined);

			// URL with /commits suffix should be rejected
			const uri2 = vscode.Uri.parse('vscode://github.vscode-pull-request-github/checkout-pull-request?uri=https://github.com/owner/repo/pull/456/commits');
			const result2 = fromOpenOrCheckoutPullRequestWebviewUri(uri2);
			assert.strictEqual(result2, undefined);
		});
	});

	describe('convertIssuePRReferencesToLinks', () => {
		const owner = 'microsoft';
		const repo = 'vscode-pull-request-github';

		it('should convert standalone issue numbers with # prefix', () => {
			const text = 'This PR addresses issue #7280.';
			const result = convertIssuePRReferencesToLinks(text, owner, repo);
			assert.strictEqual(result, 'This PR addresses issue [#7280](https://github.com/microsoft/vscode-pull-request-github/issues/7280).');
		});

		it('should convert issue references without # prefix', () => {
			const text = 'This fixes issue 123.';
			const result = convertIssuePRReferencesToLinks(text, owner, repo);
			assert.strictEqual(result, 'This fixes [issue 123](https://github.com/microsoft/vscode-pull-request-github/issues/123).');
		});

		it('should convert PR references with # prefix', () => {
			const text = 'See PR #456 for details.';
			const result = convertIssuePRReferencesToLinks(text, owner, repo);
			assert.strictEqual(result, 'See [PR #456](https://github.com/microsoft/vscode-pull-request-github/issues/456) for details.');
		});

		it('should convert PR references without # prefix', () => {
			const text = 'Related to PR 789.';
			const result = convertIssuePRReferencesToLinks(text, owner, repo);
			assert.strictEqual(result, 'Related to [PR 789](https://github.com/microsoft/vscode-pull-request-github/issues/789).');
		});

		it('should convert multiple issue/PR references in the same text', () => {
			const text = 'This fixes issue #123 and PR #456.';
			const result = convertIssuePRReferencesToLinks(text, owner, repo);
			assert.strictEqual(result, 'This fixes [issue #123](https://github.com/microsoft/vscode-pull-request-github/issues/123) and [PR #456](https://github.com/microsoft/vscode-pull-request-github/issues/456).');
		});

		it('should handle case-insensitive issue/PR keywords', () => {
			const text = 'See Issue #100 and pr #200.';
			const result = convertIssuePRReferencesToLinks(text, owner, repo);
			assert.strictEqual(result, 'See [Issue #100](https://github.com/microsoft/vscode-pull-request-github/issues/100) and [pr #200](https://github.com/microsoft/vscode-pull-request-github/issues/200).');
		});

		it('should not convert issue/PR references in the middle of words', () => {
			const text = 'This is not#123 an issue.';
			const result = convertIssuePRReferencesToLinks(text, owner, repo);
			assert.strictEqual(result, 'This is not#123 an issue.');
		});

		it('should not convert # followed by non-numeric characters', () => {
			const text = 'This is #notanissue.';
			const result = convertIssuePRReferencesToLinks(text, owner, repo);
			assert.strictEqual(result, 'This is #notanissue.');
		});

		it('should convert standalone # followed by number', () => {
			const text = 'See #42 for more info.';
			const result = convertIssuePRReferencesToLinks(text, owner, repo);
			assert.strictEqual(result, 'See [#42](https://github.com/microsoft/vscode-pull-request-github/issues/42) for more info.');
		});

		it('should handle text with no issue/PR references', () => {
			const text = 'This is just regular text.';
			const result = convertIssuePRReferencesToLinks(text, owner, repo);
			assert.strictEqual(result, 'This is just regular text.');
		});

		it('should handle empty text', () => {
			const text = '';
			const result = convertIssuePRReferencesToLinks(text, owner, repo);
			assert.strictEqual(result, '');
		});

		it('should convert pull request references with # prefix', () => {
			const text = 'See pull request #789 for details.';
			const result = convertIssuePRReferencesToLinks(text, owner, repo);
			assert.strictEqual(result, 'See [pull request #789](https://github.com/microsoft/vscode-pull-request-github/issues/789) for details.');
		});

		it('should convert pull request references without # prefix', () => {
			const text = 'Related to pull request 456.';
			const result = convertIssuePRReferencesToLinks(text, owner, repo);
			assert.strictEqual(result, 'Related to [pull request 456](https://github.com/microsoft/vscode-pull-request-github/issues/456).');
		});

		it('should handle case-insensitive pull request keyword', () => {
			const text = 'See Pull Request #100 and PULL REQUEST 200.';
			const result = convertIssuePRReferencesToLinks(text, owner, repo);
			assert.strictEqual(result, 'See [Pull Request #100](https://github.com/microsoft/vscode-pull-request-github/issues/100) and [PULL REQUEST 200](https://github.com/microsoft/vscode-pull-request-github/issues/200).');
		});
	});
});
