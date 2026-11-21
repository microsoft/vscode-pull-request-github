/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import packageJson from '../../../package.json';

describe('File change context menus', function () {
	const cases = [
		{ status: 'ADD', openOriginal: false, reveal: false },
		{ status: 'DELETE', openOriginal: true, reveal: false },
		{ status: 'MODIFY', openOriginal: true, reveal: true },
		{ status: 'RENAME', openOriginal: false, reveal: true },
		{ status: 'COPY', openOriginal: false, reveal: true },
		{ status: 'TYPE', openOriginal: false, reveal: true },
		{ status: 'UNKNOWN', openOriginal: false, reveal: true },
		{ status: 'UNMERGED', openOriginal: false, reveal: true },
	];

	for (const command of ['pr.openOriginalFile', 'pr.revealFileInOS']) {
		it(`shows ${command} only for applicable file changes`, function () {
			const menu = packageJson.contributes.menus['view/item/context'].find(item => item.command === command);
			assert.ok(menu);
			const match = /viewItem =~ \/(?<pattern>[^/]+)\//.exec(menu.when);
			assert.ok(match?.groups?.pattern);
			const pattern = new RegExp(match.groups.pattern);

			for (const testCase of cases) {
				for (const viewed of ['viewed', 'unviewed']) {
					const contextValue = `filechange:${testCase.status}:${viewed}`;
					assert.strictEqual(
						pattern.test(contextValue),
						command === 'pr.openOriginalFile' ? testCase.openOriginal : testCase.reveal,
						contextValue,
					);
				}
			}
			assert.strictEqual(pattern.test('description'), false);
		});
	}
});
