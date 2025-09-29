/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import * as vscode from 'vscode';

describe('IssueCompletionProvider Configuration', function () {
	it('should include Crystal in default ignore completion trigger list', function () {
		// This test checks that the default configuration includes Crystal
		// We access this by examining the configuration contribution from package.json
		const config = vscode.workspace.getConfiguration('githubIssues');
		const defaultIgnoreList = config.inspect('ignoreCompletionTrigger')?.defaultValue as string[];

		assert(Array.isArray(defaultIgnoreList), 'Default ignore list should be an array');
		assert(defaultIgnoreList.includes('crystal'), 'Default configuration should include Crystal language in ignore list');

		// Also verify other expected languages are still there
		const expectedLanguages = ['python', 'ruby', 'perl', 'powershell', 'julia', 'coffeescript'];
		for (const language of expectedLanguages) {
			assert(defaultIgnoreList.includes(language), `Default configuration should include ${language} in ignore list`);
		}

		// Verify the list is properly maintained in alphabetical order around crystal
		const crystalIndex = defaultIgnoreList.indexOf('crystal');
		const coffeeIndex = defaultIgnoreList.indexOf('coffeescript');
		const diffIndex = defaultIgnoreList.indexOf('diff');

		assert(crystalIndex > coffeeIndex, 'Crystal should come after coffeescript alphabetically');
		assert(crystalIndex < diffIndex, 'Crystal should come before diff alphabetically');
	});

	it('should verify ignored languages configuration structure', function () {
		const config = vscode.workspace.getConfiguration('githubIssues');
		const configInfo = config.inspect('ignoreCompletionTrigger');

		// Verify that the configuration exists and has proper structure
		assert(configInfo, 'ignoreCompletionTrigger configuration should exist');
		assert(configInfo.defaultValue, 'Should have a default value');
		assert(Array.isArray(configInfo.defaultValue), 'Default value should be an array');

		// Verify that crystal is in the list (this is the core fix)
		const defaultList = configInfo.defaultValue as string[];
		assert(defaultList.includes('crystal'), 'Crystal should be included in the default ignore list');

		// Verify list has reasonable size (should have multiple languages)
		assert(defaultList.length > 10, 'Should have a reasonable number of ignored languages');
	});
});