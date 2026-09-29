/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import { GitChangeType, InMemFileChange } from '../../common/file';

describe('InMemFileChange submodule pointers', function () {
	const base = `Subproject commit ${'a'.repeat(40)}`;
	const head = `Subproject commit ${'b'.repeat(40)}`;

	function parse(patch: string) {
		return new InMemFileChange('base', GitChangeType.MODIFY, 'submodule', undefined, patch, undefined, '').submoduleChange;
	}

	for (const [name, patch, expectedBase, expectedHead] of [
		['bump', `@@ -1 +1 @@\n-${base}\n+${head}`, base, head],
		['addition', `@@ -0,0 +1 @@\n+${head}`, '', head],
		['deletion', `@@ -1 +0,0 @@\n-${base}`, base, ''],
		['explicit line counts', `@@ -1,1 +1,1 @@\n-${base}\n+${head}`, base, head],
	]) {
		for (const newline of ['\n', '\r\n']) {
			for (const trailingNewline of ['', newline]) {
				it(`recognizes a ${name} with ${JSON.stringify(newline)} and trailing ${JSON.stringify(trailingNewline)}`, function () {
					assert.deepStrictEqual(parse(patch.replace(/\n/g, newline) + trailingNewline), {
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
			assert.strictEqual(parse(patch), undefined);
		});
	}
});
