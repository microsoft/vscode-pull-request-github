/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { initials, initialsColor, initialsSvg } from '../../common/initials';

describe('initials avatars', () => {
	it('uses the first letters of the first and last words', () => {
		assert.strictEqual(initials('James N'), 'JN');
		assert.strictEqual(initials('Euan Charles Cooper'), 'EC');
		assert.strictEqual(initials('Stiletto Build Service (Blackthorn42)'), 'SS');
		assert.strictEqual(initials('loryan'), 'L');
		assert.strictEqual(initials('jane.doe@example.com'), 'JD');
		assert.strictEqual(initials(''), '?');
		assert.strictEqual(initials(undefined), '?');
	});

	it('keeps a stable colour per name and escapes the SVG text', () => {
		assert.strictEqual(initialsColor('James N'), initialsColor('James N'));
		assert.ok(initialsSvg('<b> &', 16).includes('&lt;'));
		assert.ok(!initialsSvg('<b> &', 16).includes('<b>'));
	});
});
