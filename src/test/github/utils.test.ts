/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import * as vscode from 'vscode';
import { CUSTOM_ENTERPRISE_URI, GITHUB_ENTERPRISE, PR_SETTINGS_NAMESPACE, URI } from '../../common/settingKeys';
import { getEnterpriseUri, getPRFetchQuery, getPullRequestEnterpriseUri, sanitizeIssueTitle, setEnterpriseUri } from '../../github/utils';

describe('utils', () => {

	describe('getPRFetchQuery', () => {
		it('replaces all instances of ${user}', () => {
			const user = 'rmacfarlane';
			const query = 'reviewed-by:${user} -author:${user}';
			const result = getPRFetchQuery(user, query)
			assert.strictEqual(result, 'is:pull-request reviewed-by:rmacfarlane -author:rmacfarlane type:pr');
		});
	});

	describe('sanitizeIssueTitle', () => {
		[
			{ input: 'Issue', expected: 'Issue' },
			{ input: 'Issue A', expected: 'Issue-A' },
			{ input: 'Issue  A', expected: 'Issue-A' },
			{ input: 'Issue     A', expected: 'Issue-A' },
			{ input: 'Issue @ A', expected: 'Issue-A' },
			{ input: "Issue 'A'", expected: 'Issue-A' },
			{ input: 'Issue "A"', expected: 'Issue-A' },
			{ input: '@Issue "A"', expected: 'Issue-A' },
			{ input: 'Issue "A"%', expected: 'Issue-A' },
			{ input: 'Issue .A', expected: 'Issue-A' },
			{ input: 'Issue ,A', expected: 'Issue-A' },
			{ input: 'Issue :A', expected: 'Issue-A' },
			{ input: 'Issue ;A', expected: 'Issue-A' },
			{ input: 'Issue ~A', expected: 'Issue-A' },
			{ input: 'Issue #A', expected: 'Issue-A' },
		].forEach(testCase => {
			it(`Transforms '${testCase.input}' into '${testCase.expected}'`, () => {
				const actual = sanitizeIssueTitle(testCase.input);
				assert.strictEqual(actual, testCase.expected);
			});
		});
	});

	describe('enterprise uri settings', () => {
		const originalGetConfiguration = vscode.workspace.getConfiguration;

		afterEach(() => {
			vscode.workspace.getConfiguration = originalGetConfiguration;
		});

		function stubEnterpriseConfiguration(customEnterpriseUri: string, legacyEnterpriseUri: string, update?: (section: string, key: string, value: unknown, target: vscode.ConfigurationTarget | boolean | undefined) => Thenable<void>) {
			vscode.workspace.getConfiguration = ((section?: string) => {
				if (section === PR_SETTINGS_NAMESPACE) {
					return {
						get: (key: string, defaultValue?: string) => key === CUSTOM_ENTERPRISE_URI ? (customEnterpriseUri || defaultValue) : defaultValue,
						update: (key: string, value: unknown, target?: vscode.ConfigurationTarget | boolean) => update ? update(section, key, value, target) : Promise.resolve(),
					} as vscode.WorkspaceConfiguration;
				}

				if (section === GITHUB_ENTERPRISE) {
					return {
						get: (key: string, defaultValue?: string) => key === URI ? (legacyEnterpriseUri || defaultValue) : defaultValue,
						update: (key: string, value: unknown, target?: vscode.ConfigurationTarget | boolean) => update ? update(section, key, value, target) : Promise.resolve(),
					} as vscode.WorkspaceConfiguration;
				}

				return originalGetConfiguration(section);
			}) as typeof vscode.workspace.getConfiguration;
		}

		it('prefers githubPullRequests.customEnterpriseUri over the generic setting', () => {
			stubEnterpriseConfiguration('https://custom.example.com', 'https://legacy.example.com');

			assert.strictEqual(getPullRequestEnterpriseUri()?.authority, 'custom.example.com');
			assert.strictEqual(getEnterpriseUri()?.authority, 'custom.example.com');
		});

		it('falls back to github-enterprise.uri when extension-specific settings are unset', () => {
			stubEnterpriseConfiguration('', 'https://legacy.example.com');

			assert.strictEqual(getPullRequestEnterpriseUri(), undefined);
			assert.strictEqual(getEnterpriseUri()?.authority, 'legacy.example.com');
		});

		it('normalizes http enterprise urls to https', () => {
			stubEnterpriseConfiguration('http://pr.example.com', '');

			assert.strictEqual(getEnterpriseUri()?.toString(), 'https://pr.example.com/');
		});

		it('writes enterprise setup to the extension setting', async () => {
			let capturedUpdate: { section: string; key: string; value: unknown; target: vscode.ConfigurationTarget | boolean | undefined } | undefined;
			stubEnterpriseConfiguration('', '', async (section, key, value, target) => {
				capturedUpdate = { section, key, value, target };
			});

			await setEnterpriseUri('https://pr.example.com');

			assert.deepStrictEqual(capturedUpdate, {
				section: PR_SETTINGS_NAMESPACE,
				key: CUSTOM_ENTERPRISE_URI,
				value: 'https://pr.example.com',
				target: vscode.ConfigurationTarget.Workspace,
			});
		});
	});
});
