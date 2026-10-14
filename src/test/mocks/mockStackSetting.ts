/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { SinonSandbox } from 'sinon';
import { EXPERIMENTAL_STACKS, PR_SETTINGS_NAMESPACE } from '../../common/settingKeys';

export function mockStackSetting(sandbox: SinonSandbox): (enabled: boolean) => void {
	let enabled = true;
	const getConfiguration = vscode.workspace.getConfiguration.bind(vscode.workspace);
	sandbox.stub(vscode.workspace, 'getConfiguration').callsFake((section?: string, scope?: vscode.ConfigurationScope) => {
		const configuration = getConfiguration(section, scope);
		if (section !== PR_SETTINGS_NAMESPACE) {
			return configuration;
		}
		const mock = Object.create(configuration) as vscode.WorkspaceConfiguration;
		Object.defineProperty(mock, 'get', {
			value: (key: string, defaultValue?: unknown) =>
				key === EXPERIMENTAL_STACKS ? enabled : configuration.get(key, defaultValue),
		});
		return mock;
	});
	return value => { enabled = value; };
}
