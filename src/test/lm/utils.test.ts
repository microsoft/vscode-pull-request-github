/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import * as vscode from 'vscode';
import { chatCommand } from '../../lm/utils';
import { commands } from '../../common/executeCommands';
import { EXPERIMENTAL_USE_QUICK_CHAT, PR_SETTINGS_NAMESPACE } from '../../common/settingKeys';

describe('LM utils', function () {
	describe('chatCommand', function () {
		let originalGetConfiguration: typeof vscode.workspace.getConfiguration;

		beforeEach(function () {
			// Store the original getConfiguration function
			originalGetConfiguration = vscode.workspace.getConfiguration;
		});

		afterEach(function () {
			// Restore the original getConfiguration function
			vscode.workspace.getConfiguration = originalGetConfiguration;
		});

		it('should return QUICK_CHAT_OPEN when experimental.useQuickChat is true', function () {
			// Mock the workspace configuration
			vscode.workspace.getConfiguration = function (section?: string) {
				if (section === PR_SETTINGS_NAMESPACE) {
					return {
						get: function <T>(key: string, defaultValue?: T): T {
							if (key === EXPERIMENTAL_USE_QUICK_CHAT) {
								return (true as unknown) as T;
							}
							return defaultValue as T;
						}
					} as vscode.WorkspaceConfiguration;
				}
				return originalGetConfiguration(section);
			};

			const result = chatCommand();
			assert.strictEqual(result, commands.QUICK_CHAT_OPEN);
		});

		it('should return OPEN_CHAT when experimental.useQuickChat is false', function () {
			// Mock the workspace configuration
			vscode.workspace.getConfiguration = function (section?: string) {
				if (section === PR_SETTINGS_NAMESPACE) {
					return {
						get: function <T>(key: string, defaultValue?: T): T {
							if (key === EXPERIMENTAL_USE_QUICK_CHAT) {
								return (false as unknown) as T;
							}
							return defaultValue as T;
						}
					} as vscode.WorkspaceConfiguration;
				}
				return originalGetConfiguration(section);
			};

			const result = chatCommand();
			assert.strictEqual(result, commands.OPEN_CHAT);
		});

		it('should return OPEN_CHAT when experimental.useQuickChat is undefined (uses default)', function () {
			// Mock the workspace configuration
			vscode.workspace.getConfiguration = function (section?: string) {
				if (section === PR_SETTINGS_NAMESPACE) {
					return {
						get: function <T>(key: string, defaultValue?: T): T {
							if (key === EXPERIMENTAL_USE_QUICK_CHAT) {
								// Return the default value (false)
								return defaultValue as T;
							}
							return defaultValue as T;
						}
					} as vscode.WorkspaceConfiguration;
				}
				return originalGetConfiguration(section);
			};

			const result = chatCommand();
			assert.strictEqual(result, commands.OPEN_CHAT);
		});
	});
});