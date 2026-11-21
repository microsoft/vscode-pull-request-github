/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import { promises as fs, readdirSync } from 'fs';
import * as path from 'path';
import { getModifiedContentFromDiffHunk } from '../../common/diffHunk';

describe('Real Diff Apply', function () {
	createTestsFromFixtures(path.join(__dirname, './fixtures/gitdiff'), (original: string, diff: string, expected: string, messages: string[]) => {
		const actual = getModifiedContentFromDiffHunk(original, diff);
		assert.deepStrictEqual(actual, expected);
	});
});


function createTestsFromFixtures(testDir: string, runTest: (original: string, diff: string, expected: string, messages: string[]) => void) {
	const entries = readdirSync(testDir);
	for (const entry of entries) {

		const match = entry.match(/^(\d\d-\w+)-([^.]+)$/);
		if (match) {
			it(`${match[1]} - ${match[2].replace(/_/g, ' ')}`, async () => {
				const expected = await fs.readFile(path.join(testDir, entry), 'utf8');
				const diff = await fs.readFile(path.join(testDir, `${entry}.diff`), 'utf8');
				const original = await fs.readFile(path.join(testDir, match[1]), 'utf8');
				let messages = [];
				try {
					messages = JSON.parse(await fs.readFile(path.join(testDir, `${entry}.messages`), 'utf8'));
				} catch (e) {
					// ignore
				}
				runTest(original, diff, expected, messages);
			});
		}
	}
}
