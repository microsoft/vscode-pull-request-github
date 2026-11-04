/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { SinonSandbox } from 'sinon';
import { GITHUB_ENTERPRISE, URI, URIS } from '../../common/settingKeys';

export function mockEnterpriseUris(sandbox: SinonSandbox, uris: string[] | undefined): void {
	const getConfiguration = vscode.workspace.getConfiguration.bind(vscode.workspace);
	sandbox.stub(vscode.workspace, 'getConfiguration').callsFake((section?: string, scope?: vscode.ConfigurationScope) => {
		const configuration = getConfiguration(section, scope);
		if (section !== GITHUB_ENTERPRISE) {
			return configuration;
		}
		const mock = Object.create(configuration) as vscode.WorkspaceConfiguration;
		Object.defineProperty(mock, 'get', {
			value: (key: string, defaultValue?: unknown) => key === URIS ? (uris ?? defaultValue) : key === URI ? undefined : configuration.get(key, defaultValue),
		});
		Object.defineProperty(mock, 'inspect', {
			value: (key: string) => key === URIS ? { key: `${GITHUB_ENTERPRISE}.${URIS}`, globalValue: uris } : configuration.inspect(key),
		});
		return mock;
	});
}
