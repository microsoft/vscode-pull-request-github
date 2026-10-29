/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import { GitChangeType, InMemFileChange } from '../../common/file';

describe('InMemFileChange submodule pointers', function () {
	const baseSha = 'a'.repeat(40);
	const headSha = 'b'.repeat(40);
	const base = `Subproject commit ${baseSha}`;
	const head = `Subproject commit ${headSha}`;

	function parse(patch: string, objectSha: string | undefined) {
		return new InMemFileChange('base', GitChangeType.MODIFY, 'submodule', undefined, patch, undefined, '', objectSha).submoduleChange;
	}

	for (const [name, patch, expectedBase, expectedHead, objectSha] of [
		['bump', `@@ -1 +1 @@\n-${base}\n+${head}`, base, head, headSha],
		['addition', `@@ -0,0 +1 @@\n+${head}`, '', head, headSha],
		['deletion', `@@ -1 +0,0 @@\n-${base}`, base, '', baseSha],
		['explicit line counts', `@@ -1,1 +1,1 @@\n-${base}\n+${head}`, base, head, headSha],
	]) {
		for (const newline of ['\n', '\r\n']) {
			for (const trailingNewline of ['', newline]) {
				it(`recognizes a ${name} with ${JSON.stringify(newline)} and trailing ${JSON.stringify(trailingNewline)}`, function () {
					assert.deepStrictEqual(parse(patch.replace(/\n/g, newline) + trailingNewline, objectSha), {
						base: expectedBase ? `${expectedBase}\n` : '',
						head: expectedHead ? `${expectedHead}\n` : '',
					});
				});
			}
		}
	}

	for (const patch of [
		'',
		'@@ -1 +1 @@\n-old text\n+new text',
		`@@ -2 +2 @@\n-${base}\n+${head}`,
		`@@ -1,2 +1,2 @@\n context\n-${base}\n+${head}`,
		`@@ -1 +1 @@\n-${base}\n+${head}\n@@ -10 +10 @@\n-old\n+new`,
		'@@ -1 +1 @@\n-Subproject commit abc\n+Subproject commit def',
		`@@ -1 +1 @@\n-${base}\n+${head}\n+other content`,
		`@@ -1 +1 @@\n-${base}\n+${head}\n\\ No newline at end of file`,
	]) {
		it(`does not mistake ordinary file content for a gitlink: ${JSON.stringify(patch)}`, function () {
			assert.strictEqual(parse(patch, headSha), undefined);
		});
	}

	for (const [name, objectSha] of [
		// The blob sha of a regular file containing exactly `${head}\n`.
		['its blob sha', '46b309a7bb5b2b3d97c6fdb9dcadd27a98646ba3'],
		['the base pointer sha', baseSha],
		['no sha', undefined],
	]) {
		it(`does not mistake a regular file containing a gitlink pointer for a gitlink when the object has ${name}`, function () {
			assert.strictEqual(parse(`@@ -1 +1 @@\n-${base}\n+${head}\n`, objectSha), undefined);
		});
	}
});
