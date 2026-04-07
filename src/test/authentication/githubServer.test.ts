/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import * as vscode from 'vscode';

import { GitHubManager } from '../../authentication/githubServer';
import { GitHubServerType } from '../../common/authentication';
import { CUSTOM_ENTERPRISE_URI, GITHUB_ENTERPRISE, PR_SETTINGS_NAMESPACE, URI } from '../../common/settingKeys';

describe('GitHubManager', function () {
	const originalGetConfiguration = vscode.workspace.getConfiguration;

	afterEach(function () {
		vscode.workspace.getConfiguration = originalGetConfiguration;
	});

	function stubEnterpriseConfiguration(customEnterpriseUri: string, legacyEnterpriseUri: string) {
		vscode.workspace.getConfiguration = ((section?: string) => {
			if (section === PR_SETTINGS_NAMESPACE) {
				return {
					get: (key: string, defaultValue?: string) => key === CUSTOM_ENTERPRISE_URI ? (customEnterpriseUri || defaultValue) : defaultValue,
				} as unknown as vscode.WorkspaceConfiguration;
			}

			if (section === GITHUB_ENTERPRISE) {
				return {
					get: (key: string, defaultValue?: string) => key === URI ? (legacyEnterpriseUri || defaultValue) : defaultValue,
				} as unknown as vscode.WorkspaceConfiguration;
			}

			return originalGetConfiguration(section);
		}) as typeof vscode.workspace.getConfiguration;
	}

	it('treats the configured enterprise host as enterprise even when the exact authority was previously cached as none', async function () {
		stubEnterpriseConfiguration('https://enterprise.example.com/', '');
		const manager = new GitHubManager();
		(manager as any)._knownServers.set('enterprise.example.com', GitHubServerType.None);

		const result = await manager.isGitHub(vscode.Uri.parse('https://enterprise.example.com/example-org/example-repo.git'));

		assert.strictEqual(result, GitHubServerType.Enterprise);
	});
});