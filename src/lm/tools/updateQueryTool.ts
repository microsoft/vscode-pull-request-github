/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import { ISSUES_SETTINGS_NAMESPACE, PR_SETTINGS_NAMESPACE, QUERIES } from '../../common/settingKeys';

interface UpdateQueryParameters {
	namespace: string;
	queryName: string;
	newQuery: string;
}

export class UpdateQueryTool implements vscode.LanguageModelTool<UpdateQueryParameters> {
	public static readonly toolId = 'github-pull-request_update_query';

	async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<UpdateQueryParameters>): Promise<vscode.PreparedToolInvocation> {
		return {
			invocationMessage: vscode.l10n.t('Updating query "{0}"', options.input.queryName || 'unnamed')
		};
	}

	async invoke(options: vscode.LanguageModelToolInvocationOptions<UpdateQueryParameters>, _token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult | undefined> {
		const { namespace, queryName, newQuery } = options.input;

		// Validate inputs
		if (!namespace || !queryName || !newQuery) {
			const errorMessage = vscode.l10n.t('Missing required parameters: namespace, queryName, and newQuery are all required');
			return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(errorMessage)]);
		}

		// Validate namespace
		if (namespace !== PR_SETTINGS_NAMESPACE && namespace !== ISSUES_SETTINGS_NAMESPACE) {
			const errorMessage = vscode.l10n.t('Invalid namespace: must be either "{0}" or "{1}"', PR_SETTINGS_NAMESPACE, ISSUES_SETTINGS_NAMESPACE);
			return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(errorMessage)]);
		}

		try {
			const config = vscode.workspace.getConfiguration(namespace);
			const inspect = config.inspect<{ label: string; query: string }[]>(QUERIES);

			// Find the target to update based on the hierarchy
			let newValue: { label: string; query: string }[];
			let target: vscode.ConfigurationTarget;

			if (inspect?.workspaceFolderValue) {
				target = vscode.ConfigurationTarget.WorkspaceFolder;
				newValue = [...inspect.workspaceFolderValue];
			} else if (inspect?.workspaceValue) {
				target = vscode.ConfigurationTarget.Workspace;
				newValue = [...inspect.workspaceValue];
			} else {
				target = vscode.ConfigurationTarget.Global;
				newValue = [...(config.get<{ label: string; query: string }[]>(QUERIES) ?? [])];
			}

			// Find and update the query
			const queryIndex = newValue.findIndex(query => query.label === queryName);
			if (queryIndex === -1) {
				const errorMessage = vscode.l10n.t('Query "{0}" not found', queryName);
				return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(errorMessage)]);
			}

			const oldQuery = newValue[queryIndex].query;
			newValue[queryIndex].query = newQuery;

			// Update the configuration
			await config.update(QUERIES, newValue, target);

			const successMessage = vscode.l10n.t('Successfully updated query "{0}" from "{1}" to "{2}"', queryName, oldQuery, newQuery);
			return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(successMessage)]);

		} catch (error) {
			const errorMessage = vscode.l10n.t('Failed to update query: {0}', error instanceof Error ? error.message : String(error));
			return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(errorMessage)]);
		}
	}
}