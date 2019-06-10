import assert = require('assert');
import { parseDiffHunk } from '../common/diffHunk';

describe('Extension Tests', function () {

	describe('parseDiffHunk', () => {
		it('should handle empty string', () => {
			const diffHunk = parseDiffHunk('');
			const itr = diffHunk.next();
			assert.equal(itr.done, true);
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
			assert.equal(itr.value.oldLineNumber, 5);
			assert.equal(itr.value.newLineNumber, 5);
			assert.equal(itr.value.oldLength, 6);
			assert.equal(itr.value.newLength, 9);
			assert.equal(itr.value.positionInHunk, 0);
			assert.equal(itr.value.diffLines.length, 10);
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
			assert.equal(itr.value.oldLineNumber, 5);
			assert.equal(itr.value.newLineNumber, 5);
			assert.equal(itr.value.oldLength, 9);
			assert.equal(itr.value.newLength, 6);
			assert.equal(itr.value.positionInHunk, 0);
			assert.equal(itr.value.diffLines.length, 10);
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
			assert.equal(itr.value.oldLineNumber, 5);
			assert.equal(itr.value.newLineNumber, 5);
			assert.equal(itr.value.oldLength, 9);
			assert.equal(itr.value.newLength, 7);
			assert.equal(itr.value.positionInHunk, 0);
			assert.equal(itr.value.diffLines.length, 11);
		});
	});
});
