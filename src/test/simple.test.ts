/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';

describe('Simple Test', function () {
	it('should pass a basic assertion', function () {
		assert.strictEqual(1 + 1, 2);
	});

	it('should pass a string comparison', function () {
		assert.strictEqual('test', 'test');
	});

	it('should pass a boolean check', function () {
		assert.strictEqual(true, true);
	});
});
