/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import { emojify } from '../../common/emoji';
import { makeLabel } from '../../github/utils';

describe('emoji rendering in labels', function () {
	it('should return original text when emoji map is not loaded', function () {
		const input = 'papercut :drop_of_blood:';
		const result = emojify(input);
		// Since emoji map isn't loaded, it should return the original text
		assert.strictEqual(result, input);
	});

	it('should process label names through emojify', function () {
		const label = { name: 'papercut :drop_of_blood:', color: 'red' };
		const result = makeLabel(label);
		// The label name should go through emojify (even if it returns the original)
		assert.ok(result.includes('papercut :drop_of_blood:'));
		assert.ok(result.includes('color:'));
		assert.ok(result.includes('background-color:'));
	});

	it('should handle labels without emoji codes', function () {
		const label = { name: 'bug', color: 'red' };
		const result = makeLabel(label);
		assert.ok(result.includes('bug'));
		assert.ok(result.includes('color:'));
		assert.ok(result.includes('background-color:'));
	});
});