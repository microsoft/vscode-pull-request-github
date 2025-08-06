/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import { parseDiff, getGitChangeType } from '../../common/diffHunk';
import { GitChangeType, InMemFileChange, SlimFileChange } from '../../common/file';
import { IRawFileChange } from '../../github/interface';

describe('Diff Parsing Comprehensive Tests', () => {
	describe('parseDiff function', () => {
		it('should handle mixed file operations in a single diff', async () => {
			const fileChanges: IRawFileChange[] = [
				// Added file with content
				{
					sha: 'abc123',
					filename: 'new-file.ts',
					status: 'added',
					additions: 10,
					deletions: 0,
					changes: 10,
					patch: `@@ -0,0 +1,3 @@
+export function newFunction() {
+  return 'Hello World';
+}`,
					blob_url: 'https://github.com/test/repo/blob/abc123/new-file.ts',
					raw_url: 'https://github.com/test/repo/raw/abc123/new-file.ts',
					contents_url: 'https://api.github.com/repos/test/repo/contents/new-file.ts',
					previous_filename: undefined
				},
				// Modified file
				{
					sha: 'abc123',
					filename: 'existing-file.ts',
					status: 'modified',
					additions: 2,
					deletions: 1,
					changes: 3,
					patch: `@@ -1,3 +1,4 @@
 function existingFunction() {
-  return 'old value';
+  return 'new value';
+  console.log('added line');
 }`,
					blob_url: 'https://github.com/test/repo/blob/abc123/existing-file.ts',
					raw_url: 'https://github.com/test/repo/raw/abc123/existing-file.ts',
					contents_url: 'https://api.github.com/repos/test/repo/contents/existing-file.ts',
					previous_filename: undefined
				},
				// Deleted file
				{
					sha: 'abc123',
					filename: 'deleted-file.ts',
					status: 'removed',
					additions: 0,
					deletions: 5,
					changes: 5,
					patch: `@@ -1,5 +0,0 @@
-function deletedFunction() {
-  return 'this will be deleted';
-}
-
-export { deletedFunction };`,
					blob_url: 'https://github.com/test/repo/blob/abc123/deleted-file.ts',
					raw_url: 'https://github.com/test/repo/raw/abc123/deleted-file.ts',
					contents_url: 'https://api.github.com/repos/test/repo/contents/deleted-file.ts',
					previous_filename: undefined
				},
				// Renamed file
				{
					sha: 'abc123',
					filename: 'new-name.ts',
					status: 'renamed',
					additions: 0,
					deletions: 0,
					changes: 0,
					patch: undefined,
					blob_url: 'https://github.com/test/repo/blob/abc123/new-name.ts',
					raw_url: 'https://github.com/test/repo/raw/abc123/new-name.ts',
					contents_url: 'https://api.github.com/repos/test/repo/contents/new-name.ts',
					previous_filename: 'old-name.ts'
				}
			];

			const result = await parseDiff(fileChanges, 'commit-sha');
			
			assert.strictEqual(result.length, 4);
			
			// Added file should be InMemFileChange
			assert.ok(result[0] instanceof InMemFileChange);
			assert.strictEqual(result[0].fileName, 'new-file.ts');
			assert.strictEqual(result[0].status, GitChangeType.ADD);
			
			// Modified file should be InMemFileChange
			assert.ok(result[1] instanceof InMemFileChange);
			assert.strictEqual(result[1].fileName, 'existing-file.ts');
			assert.strictEqual(result[1].status, GitChangeType.MODIFY);
			
			// Deleted file should be InMemFileChange
			assert.ok(result[2] instanceof InMemFileChange);
			assert.strictEqual(result[2].fileName, 'deleted-file.ts');
			assert.strictEqual(result[2].status, GitChangeType.DELETE);
			
			// Renamed file should be SlimFileChange (no patch)
			assert.ok(result[3] instanceof SlimFileChange);
			assert.strictEqual(result[3].fileName, 'new-name.ts');
			assert.strictEqual(result[3].previousFileName, 'old-name.ts');
			assert.strictEqual(result[3].status, GitChangeType.RENAME);
		});

		it('should handle binary files correctly', async () => {
			const fileChanges: IRawFileChange[] = [
				{
					sha: 'abc123',
					filename: 'image.png',
					status: 'added',
					additions: 0,
					deletions: 0,
					changes: 0,
					patch: undefined, // Binary files don't have text patches
					blob_url: 'https://github.com/test/repo/blob/abc123/image.png',
					raw_url: 'https://github.com/test/repo/raw/abc123/image.png',
					contents_url: 'https://api.github.com/repos/test/repo/contents/image.png',
					previous_filename: undefined
				},
				{
					sha: 'abc123',
					filename: 'document.pdf',
					status: 'modified',
					additions: 0,
					deletions: 0,
					changes: 0,
					patch: undefined,
					blob_url: 'https://github.com/test/repo/blob/abc123/document.pdf',
					raw_url: 'https://github.com/test/repo/raw/abc123/document.pdf',
					contents_url: 'https://api.github.com/repos/test/repo/contents/document.pdf',
					previous_filename: undefined
				}
			];

			const result = await parseDiff(fileChanges, 'commit-sha');
			
			assert.strictEqual(result.length, 2);
			
			// Binary files should be SlimFileChange
			assert.ok(result[0] instanceof SlimFileChange);
			assert.strictEqual(result[0].fileName, 'image.png');
			assert.strictEqual(result[0].status, GitChangeType.ADD);
			
			assert.ok(result[1] instanceof SlimFileChange);
			assert.strictEqual(result[1].fileName, 'document.pdf');
			assert.strictEqual(result[1].status, GitChangeType.MODIFY);
		});

		it('should skip empty file additions', async () => {
			const fileChanges: IRawFileChange[] = [
				{
					sha: 'abc123',
					filename: 'empty.txt',
					status: 'added',
					additions: 0,
					deletions: 0,
					changes: 0,
					patch: undefined,
					blob_url: 'https://github.com/test/repo/blob/abc123/empty.txt',
					raw_url: 'https://github.com/test/repo/raw/abc123/empty.txt',
					contents_url: 'https://api.github.com/repos/test/repo/contents/empty.txt',
					previous_filename: undefined
				},
				{
					sha: 'abc123',
					filename: 'normal.txt',
					status: 'added',
					additions: 1,
					deletions: 0,
					changes: 1,
					patch: '@@ -0,0 +1 @@\n+Hello',
					blob_url: 'https://github.com/test/repo/blob/abc123/normal.txt',
					raw_url: 'https://github.com/test/repo/raw/abc123/normal.txt',
					contents_url: 'https://api.github.com/repos/test/repo/contents/normal.txt',
					previous_filename: undefined
				}
			];

			const result = await parseDiff(fileChanges, 'commit-sha');
			
			// Empty file additions should be skipped
			assert.strictEqual(result.length, 1);
			assert.strictEqual(result[0].fileName, 'normal.txt');
		});

		it('should handle complex rename with modifications', async () => {
			const fileChanges: IRawFileChange[] = [
				{
					sha: 'abc123',
					filename: 'src/components/NewComponent.tsx',
					status: 'renamed',
					additions: 3,
					deletions: 1,
					changes: 4,
					patch: `@@ -1,7 +1,9 @@
 import React from 'react';
 
-export function OldComponent() {
+export function NewComponent() {
   return (
-    <div>Old Component</div>
+    <div>New Component</div>
+    <p>Additional content</p>
   );
 }
+
+export default NewComponent;`,
					blob_url: 'https://github.com/test/repo/blob/abc123/src/components/NewComponent.tsx',
					raw_url: 'https://github.com/test/repo/raw/abc123/src/components/NewComponent.tsx',
					contents_url: 'https://api.github.com/repos/test/repo/contents/src/components/NewComponent.tsx',
					previous_filename: 'src/components/OldComponent.tsx'
				}
			];

			const result = await parseDiff(fileChanges, 'commit-sha');
			
			assert.strictEqual(result.length, 1);
			assert.ok(result[0] instanceof InMemFileChange);
			assert.strictEqual(result[0].fileName, 'src/components/NewComponent.tsx');
			assert.strictEqual(result[0].previousFileName, 'src/components/OldComponent.tsx');
			assert.strictEqual(result[0].status, GitChangeType.RENAME);
			assert.ok((result[0] as InMemFileChange).patch.includes('NewComponent'));
		});
	});

	describe('getGitChangeType edge cases', () => {
		it('should handle case sensitivity correctly', () => {
			// The function should be case sensitive
			assert.strictEqual(getGitChangeType('Added'), GitChangeType.UNKNOWN);
			assert.strictEqual(getGitChangeType('MODIFIED'), GitChangeType.UNKNOWN);
			assert.strictEqual(getGitChangeType('Removed'), GitChangeType.UNKNOWN);
		});

		it('should handle null and undefined values', () => {
			assert.strictEqual(getGitChangeType(null as any), GitChangeType.UNKNOWN);
			assert.strictEqual(getGitChangeType(undefined as any), GitChangeType.UNKNOWN);
		});

		it('should handle empty strings and whitespace', () => {
			assert.strictEqual(getGitChangeType(''), GitChangeType.UNKNOWN);
			assert.strictEqual(getGitChangeType('  '), GitChangeType.UNKNOWN);
			assert.strictEqual(getGitChangeType('\t'), GitChangeType.UNKNOWN);
		});

		it('should handle unexpected status values', () => {
			assert.strictEqual(getGitChangeType('copied'), GitChangeType.UNKNOWN);
			assert.strictEqual(getGitChangeType('changed'), GitChangeType.UNKNOWN);
			assert.strictEqual(getGitChangeType('123'), GitChangeType.UNKNOWN);
		});
	});
});