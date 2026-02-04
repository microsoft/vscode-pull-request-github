/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import * as vscode from 'vscode';
import { fromOpenOrCheckoutPullRequestWebviewUri } from '../../common/uri';
import { isValidWorkspaceUri } from '../../uriHandler';

describe('uri', () => {
	describe('isValidWorkspaceUri', () => {
		it('should return true for valid Unix file URIs', () => {
			const uri = vscode.Uri.parse('file:///home/user/repos/vscode');
			assert.strictEqual(isValidWorkspaceUri(uri), true);
		});

		it('should return true for valid Windows file URIs', () => {
			const uri = vscode.Uri.parse('file:///c%3A/Users/dmitriv/repos/vscode');
			assert.strictEqual(isValidWorkspaceUri(uri), true);
		});

		it('should return false for numeric-only path URIs (timestamps)', () => {
			const uri = vscode.Uri.parse('file:///1761808101585');
			assert.strictEqual(isValidWorkspaceUri(uri), false);
		});

		it('should return false for non-file scheme URIs', () => {
			const uri = vscode.Uri.parse('https://github.com/microsoft/vscode');
			assert.strictEqual(isValidWorkspaceUri(uri), false);
		});

		it('should return true for paths that contain numbers mixed with letters', () => {
			const uri = vscode.Uri.parse('file:///home/user123/repos');
			assert.strictEqual(isValidWorkspaceUri(uri), true);
		});

		it('should return true for paths that end with numbers', () => {
			const uri = vscode.Uri.parse('file:///home/project/version2');
			assert.strictEqual(isValidWorkspaceUri(uri), true);
		});
	});

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

		it('should work for open-pull-request-changes path', () => {
			const uri = vscode.Uri.parse('vscode://github.vscode-pull-request-github/open-pull-request-changes?uri=https://github.com/test/example/pull/999');
			const result = fromOpenOrCheckoutPullRequestWebviewUri(uri);

			assert.strictEqual(result?.owner, 'test');
			assert.strictEqual(result?.repo, 'example');
			assert.strictEqual(result?.pullRequestNumber, 999);
		});

		it('should parse JSON format for open-pull-request-changes path', () => {
			const uri = vscode.Uri.parse('vscode://github.vscode-pull-request-github/open-pull-request-changes?%7B%22owner%22%3A%22testowner%22%2C%22repo%22%3A%22testrepo%22%2C%22pullRequestNumber%22%3A123%7D');
			const result = fromOpenOrCheckoutPullRequestWebviewUri(uri);

			assert.strictEqual(result?.owner, 'testowner');
			assert.strictEqual(result?.repo, 'testrepo');
			assert.strictEqual(result?.pullRequestNumber, 123);
		});
	});
});
