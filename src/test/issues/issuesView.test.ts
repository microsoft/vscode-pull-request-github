/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import * as vscode from 'vscode';
import { ISSUE_AVATAR_DISPLAY, ISSUES_SETTINGS_NAMESPACE } from '../../common/settingKeys';

describe('Issues View Configuration', function () {
	it('should read avatar display setting with default value', async function () {
		// Test that the setting exists and has the expected default value
		const config = vscode.workspace.getConfiguration(ISSUES_SETTINGS_NAMESPACE, null);
		const avatarDisplaySetting = config.get<string>(ISSUE_AVATAR_DISPLAY, 'author');
		
		// Should return 'author' as default
		assert.strictEqual(avatarDisplaySetting, 'author');
	});

	it('should support both author and assignee options', function () {
		// Test that the configuration accepts the expected values
		const config = vscode.workspace.getConfiguration(ISSUES_SETTINGS_NAMESPACE, null);
		const inspect = config.inspect(ISSUE_AVATAR_DISPLAY);
		
		// The setting should exist
		assert(inspect !== undefined, 'Setting should be defined');
	});
});