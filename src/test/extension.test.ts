/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import * as vscode from 'vscode';
import { parseDiffHunk } from '../common/diffHunk';

describe('Extension Tests', function () {
	describe('Hello World Command', () => {
		it('should be registered and executable', async () => {
			const commands = await vscode.commands.getCommands(true);
			assert(commands.includes('pr.helloWorld'), 'Hello World command should be registered');
		});
	});

	describe('parseDiffHunk', () => {
		it('should handle empty string', () => {
			const diffHunk = parseDiffHunk('');
			const itr = diffHunk.next();
			assert.strictEqual(itr.done, true);
		});

		it('should handle additions', () => {
			const patch = [
				`@@ -5,6 +5,9 @@ if (!defined $initial_reply_to && $prompting) {`,
				` }`,
				` `,
				` if (!$smtp_server) {`,
				`+       $smtp_server = $repo->config('sendemail.smtpserver');`,
				`+}`,
				`+if (!$smtp_server) {`,
				` 	foreach (qw( /usr/sbin/sendmail /usr/lib/sendmail )) {`,
				` 	if (-x $_) {`,
				` 	$smtp_server = $_;`,
			].join('\n');
			const diffHunk = parseDiffHunk(patch);

			const itr = diffHunk.next();
			assert.notEqual(itr.value, undefined);
			assert.strictEqual(itr.value.oldLineNumber, 5);
			assert.strictEqual(itr.value.newLineNumber, 5);
			assert.strictEqual(itr.value.oldLength, 6);
			assert.strictEqual(itr.value.newLength, 9);
			assert.strictEqual(itr.value.positionInHunk, 0);
			assert.strictEqual(itr.value.diffLines.length, 10);
		});

		it('should handle deletions', () => {
			const patch = [
				`@@ -5,9 +5,6 @@ if (!defined $initial_reply_to && $prompting) {`,
				` }`,
				` `,
				` if (!$smtp_server) {`,
				`-       $smtp_server = $repo->config('sendemail.smtpserver');`,
				`-}`,
				`-if (!$smtp_server) {`,
				` 	foreach (qw( /usr/sbin/sendmail /usr/lib/sendmail )) {`,
				` 	if (-x $_) {`,
				` 	$smtp_server = $_;`,
			].join('\n');
			const diffHunk = parseDiffHunk(patch);

			const itr = diffHunk.next();
			assert.notEqual(itr.value, undefined);
			assert.strictEqual(itr.value.oldLineNumber, 5);
			assert.strictEqual(itr.value.newLineNumber, 5);
			assert.strictEqual(itr.value.oldLength, 9);
			assert.strictEqual(itr.value.newLength, 6);
			assert.strictEqual(itr.value.positionInHunk, 0);
			assert.strictEqual(itr.value.diffLines.length, 10);
		});

		it('should handle replacements', () => {
			const patch = [
				`@@ -5,9 +5,7 @@ if (!defined $initial_reply_to && $prompting) {`,
				` }`,
				` `,
				` if (!$smtp_server) {`,
				`-       $smtp_server = $repo->config('sendemail.smtpserver');`,
				`-}`,
				`-if (!$smtp_server) {`,
				`+if (fpt_server) {`,
				` 	foreach (qw( /usr/sbin/sendmail /usr/lib/sendmail )) {`,
				` 	if (-x $_) {`,
				` 	$smtp_server = $_;`,
			].join('\n');
			const diffHunk = parseDiffHunk(patch);

			const itr = diffHunk.next();
			assert.notEqual(itr.value, undefined);
			assert.strictEqual(itr.value.oldLineNumber, 5);
			assert.strictEqual(itr.value.newLineNumber, 5);
			assert.strictEqual(itr.value.oldLength, 9);
			assert.strictEqual(itr.value.newLength, 7);
			assert.strictEqual(itr.value.positionInHunk, 0);
			assert.strictEqual(itr.value.diffLines.length, 11);
		});
	});
});
