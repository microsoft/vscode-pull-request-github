/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import * as utils from '../../common/utils';
import { EventEmitter } from 'vscode';
import * as timers from 'timers';

describe('utils', () => {
	class HookError extends Error {
		public errors: any[];

		constructor(message: string, errors: any[]) {
			super(message);
			this.errors = errors;
		}
	}

	describe('formatError', () => {
		it('should format a normal error', () => {
			const error = new Error('No!');
			assert.strictEqual(utils.formatError(error), 'No!');
		});

		it('should format an error with submessages', () => {
			const error = new HookError('Validation Failed', [
				{ message: 'user_id can only have one pending review per pull request' },
			]);
			assert.strictEqual(utils.formatError(error), 'user_id can only have one pending review per pull request');
		});

		it('should not format when error message contains all information', () => {
			const error = new HookError('Validation Failed: Some Validation error', []);
			assert.strictEqual(utils.formatError(error), 'Validation Failed: Some Validation error');
		});

		it('should format an error with submessages that are strings', () => {
			const error = new HookError('Validation Failed', ['Can not approve your own pull request']);
			assert.strictEqual(utils.formatError(error), 'Can not approve your own pull request');
		});

		it('should format an error with field errors', () => {
			const error = new HookError('Validation Failed', [{ field: 'title', value: 'garbage', status: 'custom' }]);
			assert.strictEqual(utils.formatError(error), 'Validation Failed: Value "garbage" cannot be set for field title (code: custom)');
		});

		it('should format an error with custom ', () => {
			const error = new HookError('Validation Failed', [{ message: 'Cannot push to this repo', status: 'custom' }]);
			assert.strictEqual(utils.formatError(error), 'Cannot push to this repo');
		});
	});

	describe('processPermalinks', () => {
		const repoName = 'vscode';
		const authority = 'github.com';
		const sha = 'a'.repeat(40);

		function makePermalink(filePath: string, startLine: number, endLine?: number): string {
			const lineRef = endLine ? `#L${startLine}-L${endLine}` : `#L${startLine}`;
			return `<a href="https://github.com/microsoft/vscode/blob/${sha}/${filePath}${lineRef}">link text</a>`;
		}

		it('should add data attributes when file exists locally', async () => {
			const html = makePermalink('src/file.ts', 10);
			const result = await utils.processPermalinks(html, repoName, authority, async () => true);

			assert(result.includes('data-local-file="src/file.ts"'));
			assert(result.includes('data-start-line="10"'));
			assert(result.includes('data-end-line="10"'));
			assert(result.includes('data-link-type="blob"'));
			assert(result.includes('data-permalink-processed="true"'));
			assert(result.includes('view on GitHub'));
		});

		it('should set end line when range is specified', async () => {
			const html = makePermalink('src/file.ts', 10, 20);
			const result = await utils.processPermalinks(html, repoName, authority, async () => true);

			assert(result.includes('data-start-line="10"'));
			assert(result.includes('data-end-line="20"'));
		});

		it('should not modify links when file does not exist locally', async () => {
			const html = makePermalink('src/file.ts', 10);
			const result = await utils.processPermalinks(html, repoName, authority, async () => false);

			assert.strictEqual(result, html);
		});

		it('should not modify non-permalink links', async () => {
			const html = '<a href="https://example.com">example</a>';
			const result = await utils.processPermalinks(html, repoName, authority, async () => true);

			assert.strictEqual(result, html);
		});

		it('should not modify links to a different repo', async () => {
			const html = `<a href="https://github.com/other/repo/blob/${sha}/src/file.ts#L10">link</a>`;
			const result = await utils.processPermalinks(html, repoName, authority, async () => true);

			assert.strictEqual(result, html);
		});

		it('should skip already processed links', async () => {
			const html = `<a data-permalink-processed="true" href="https://github.com/microsoft/vscode/blob/${sha}/src/file.ts#L10">link</a>`;
			const result = await utils.processPermalinks(html, repoName, authority, async () => true);

			assert.strictEqual(result, html);
		});

		it('should process multiple links independently', async () => {
			const html = makePermalink('src/exists.ts', 1) + makePermalink('src/missing.ts', 2);
			const result = await utils.processPermalinks(html, repoName, authority, async (path) => path === 'src/exists.ts');

			assert(result.includes('data-local-file="src/exists.ts"'));
			assert(!result.includes('data-local-file="src/missing.ts"'));
		});

		it('should return original HTML when fileExistsCheck throws', async () => {
			const html = makePermalink('src/file.ts', 10);
			const result = await utils.processPermalinks(html, repoName, authority, async () => { throw new Error('fail'); });

			assert.strictEqual(result, html);
		});

		it('should handle links without surrounding text', async () => {
			const html = makePermalink('src/file.ts', 5);
			const result = await utils.processPermalinks(html, repoName, authority, async () => true);

			assert(result.includes('link text'));
			assert(result.includes('data-local-file="src/file.ts"'));
		});
	});

	describe('processDiffLinks', () => {
		const repoOwner = 'microsoft';
		const repoName = 'vscode';
		const authority = 'github.com';
		const prNumber = 123;
		const diffHash = 'a'.repeat(64);

		function makeDiffLink(hash: string, startLine?: number, endLine?: number, variant: 'files' | 'changes' = 'files'): string {
			let fragment = `diff-${hash}`;
			if (startLine !== undefined) {
				fragment += `R${startLine}`;
				if (endLine !== undefined) {
					fragment += `-R${endLine}`;
				}
			}
			return `<a href="https://github.com/microsoft/vscode/pull/${prNumber}/${variant}#${fragment}">link text</a>`;
		}

		it('should add data attributes when hash maps to a file', async () => {
			const hashMap: Record<string, string> = { [diffHash]: 'src/file.ts' };
			const html = makeDiffLink(diffHash, 10);
			const result = await utils.processDiffLinks(html, repoOwner, repoName, authority, hashMap, prNumber);

			assert(result.includes('data-local-file="src/file.ts"'));
			assert(result.includes('data-start-line="10"'));
			assert(result.includes('data-end-line="10"'));
			assert(result.includes('data-link-type="diff"'));
			assert(result.includes('data-permalink-processed="true"'));
			assert(result.includes('view on GitHub'));
		});

		it('should set end line when range is specified', async () => {
			const hashMap: Record<string, string> = { [diffHash]: 'src/file.ts' };
			const html = makeDiffLink(diffHash, 10, 20);
			const result = await utils.processDiffLinks(html, repoOwner, repoName, authority, hashMap, prNumber);

			assert(result.includes('data-start-line="10"'));
			assert(result.includes('data-end-line="20"'));
		});

		it('should default start line to 1 when no line is specified', async () => {
			const hashMap: Record<string, string> = { [diffHash]: 'src/file.ts' };
			const html = makeDiffLink(diffHash);
			const result = await utils.processDiffLinks(html, repoOwner, repoName, authority, hashMap, prNumber);

			assert(result.includes('data-start-line="1"'));
			assert(result.includes('data-end-line="1"'));
		});

		it('should not modify links when hash is not in the map', async () => {
			const hashMap: Record<string, string> = {};
			const html = makeDiffLink(diffHash, 10);
			const result = await utils.processDiffLinks(html, repoOwner, repoName, authority, hashMap, prNumber);

			assert.strictEqual(result, html);
		});

		it('should not modify non-diff links', async () => {
			const hashMap: Record<string, string> = { [diffHash]: 'src/file.ts' };
			const html = '<a href="https://example.com">example</a>';
			const result = await utils.processDiffLinks(html, repoOwner, repoName, authority, hashMap, prNumber);

			assert.strictEqual(result, html);
		});

		it('should not modify links to a different repo', async () => {
			const hashMap: Record<string, string> = { [diffHash]: 'src/file.ts' };
			const html = `<a href="https://github.com/other/repo/pull/${prNumber}/files#diff-${diffHash}R10">link</a>`;
			const result = await utils.processDiffLinks(html, repoOwner, repoName, authority, hashMap, prNumber);

			assert.strictEqual(result, html);
		});

		it('should skip already processed links', async () => {
			const hashMap: Record<string, string> = { [diffHash]: 'src/file.ts' };
			const html = `<a data-permalink-processed="true" href="https://github.com/microsoft/vscode/pull/${prNumber}/files#diff-${diffHash}R10">link</a>`;
			const result = await utils.processDiffLinks(html, repoOwner, repoName, authority, hashMap, prNumber);

			assert.strictEqual(result, html);
		});

		it('should match links using changes variant', async () => {
			const hashMap: Record<string, string> = { [diffHash]: 'src/file.ts' };
			const html = makeDiffLink(diffHash, 5, undefined, 'changes');
			const result = await utils.processDiffLinks(html, repoOwner, repoName, authority, hashMap, prNumber);

			assert(result.includes('data-local-file="src/file.ts"'));
			assert(result.includes('data-start-line="5"'));
		});

		it('should process multiple links independently', async () => {
			const otherHash = 'b'.repeat(64);
			const hashMap: Record<string, string> = { [diffHash]: 'src/found.ts' };
			const html = makeDiffLink(diffHash, 1) + makeDiffLink(otherHash, 2);
			const result = await utils.processDiffLinks(html, repoOwner, repoName, authority, hashMap, prNumber);

			assert(result.includes('data-local-file="src/found.ts"'));
			assert(!result.includes('data-local-file="src/other.ts"'));
		});
	});
});
