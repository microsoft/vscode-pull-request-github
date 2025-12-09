/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import { InMemFileChange, SlimFileChange, GitChangeType } from '../../common/file';

describe('File Change with additions/deletions', () => {
	it('InMemFileChange should store additions and deletions', () => {
		const fileChange = new InMemFileChange(
			'base-commit-sha',
			GitChangeType.MODIFY,
			'test-file.ts',
			undefined,
			'@@ -1,1 +1,1 @@\n-old\n+new',
			undefined,
			'https://blob-url',
			10,
			5
		);

		assert.strictEqual(fileChange.additions, 10);
		assert.strictEqual(fileChange.deletions, 5);
		assert.strictEqual(fileChange.fileName, 'test-file.ts');
		assert.strictEqual(fileChange.status, GitChangeType.MODIFY);
	});

	it('InMemFileChange should handle undefined additions/deletions', () => {
		const fileChange = new InMemFileChange(
			'base-commit-sha',
			GitChangeType.ADD,
			'new-file.ts',
			undefined,
			'',
			undefined,
			'https://blob-url',
			undefined,
			undefined
		);

		assert.strictEqual(fileChange.additions, undefined);
		assert.strictEqual(fileChange.deletions, undefined);
	});

	it('SlimFileChange should store additions and deletions', () => {
		const fileChange = new SlimFileChange(
			'base-commit-sha',
			'https://blob-url',
			GitChangeType.MODIFY,
			'slim-file.ts',
			undefined,
			20,
			15
		);

		assert.strictEqual(fileChange.additions, 20);
		assert.strictEqual(fileChange.deletions, 15);
		assert.strictEqual(fileChange.fileName, 'slim-file.ts');
		assert.strictEqual(fileChange.status, GitChangeType.MODIFY);
	});

	it('SlimFileChange should handle undefined additions/deletions', () => {
		const fileChange = new SlimFileChange(
			'base-commit-sha',
			'https://blob-url',
			GitChangeType.DELETE,
			'deleted-file.ts',
			undefined,
			undefined,
			undefined
		);

		assert.strictEqual(fileChange.additions, undefined);
		assert.strictEqual(fileChange.deletions, undefined);
	});
});
