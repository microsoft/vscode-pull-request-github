/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import { JSDOC_NON_USERS } from '../../common/user';

describe('User utilities', function () {
	it('JSDOC_NON_USERS includes effect', function () {
		assert(JSDOC_NON_USERS.includes('effect'), 'JSDOC_NON_USERS should include "effect"');
	});

	it('JSDOC_NON_USERS includes common tags', function () {
		// Verify a few common tags are in the list
		assert(JSDOC_NON_USERS.includes('param'), 'JSDOC_NON_USERS should include "param"');
		assert(JSDOC_NON_USERS.includes('returns'), 'JSDOC_NON_USERS should include "returns"');
		assert(JSDOC_NON_USERS.includes('deprecated'), 'JSDOC_NON_USERS should include "deprecated"');
	});
});
