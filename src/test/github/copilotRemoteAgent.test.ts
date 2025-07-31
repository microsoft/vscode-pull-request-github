/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';

describe('CopilotRemoteAgentManager - Secondary Session Problem Statement Retrieval', function () {
	it('should extract title from problem statement correctly', function () {
		// Test the TITLE extraction logic that was added to secondary sessions
		const problemStatement1 = 'TITLE: Fix secondary session issue\nThis is a test problem statement for secondary sessions.';
		const titleMatch1 = problemStatement1.match(/TITLE: \s*(.*)/i);
		assert.strictEqual(titleMatch1?.[1]?.trim(), 'Fix secondary session issue');

		// Test with different formatting
		const problemStatement2 = 'TITLE:   Handle chat sessions properly  \nDetailed description here.';
		const titleMatch2 = problemStatement2.match(/TITLE: \s*(.*)/i);
		assert.strictEqual(titleMatch2?.[1]?.trim(), 'Handle chat sessions properly');

		// Test without TITLE prefix
		const problemStatement3 = 'Just a regular problem statement without title';
		const titleMatch3 = problemStatement3.match(/TITLE: \s*(.*)/i);
		assert.strictEqual(titleMatch3, null);
	});
});