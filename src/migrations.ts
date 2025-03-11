/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as PersistentState from './common/persistentState';
import { BRANCH_PUBLISH, PR_SETTINGS_NAMESPACE, QUERIES } from './common/settingKeys';

const PROMPTS_SCOPE = 'prompts';
const PROMPT_TO_CREATE_PR_ON_PUBLISH_KEY = 'createPROnPublish';

export async function migrate(context: vscode.ExtensionContext) {
	await createOnPublish();
	await makeQueriesScopedToRepo(context);
}

async function createOnPublish() {
	// Migrate from state to setting
	if (PersistentState.fetch(PROMPTS_SCOPE, PROMPT_TO_CREATE_PR_ON_PUBLISH_KEY) === false) {
		await vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE).update(BRANCH_PUBLISH, 'never', vscode.ConfigurationTarget.Global);
		PersistentState.store(PROMPTS_SCOPE, PROMPT_TO_CREATE_PR_ON_PUBLISH_KEY, true);
	}
}

const HAS_MIGRATED_QUERIES = 'hasMigratedQueries';
async function makeQueriesScopedToRepo(context: vscode.ExtensionContext) {
	const hasMigratedUserQueries = context.globalState.get<boolean>(HAS_MIGRATED_QUERIES, false);
	const hasMigratedWorkspaceQueries = context.workspaceState.get<boolean>(HAS_MIGRATED_QUERIES, false);
	if (hasMigratedUserQueries && hasMigratedWorkspaceQueries) {
		return;
	}

	const configuration = vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE);
	const settingValue = configuration.inspect(QUERIES);

	type Query = {
		label: string,
		query: string,
	};
	const addRepoScope = (queries: Query[]) => {
		return queries.map(query => {
			return {
				label: query.label,
				query: query.query.includes('repo:') ? query.query : `repo:\${owner}/\${repository} ${query.query}`,
			};
		});
	};

	// User setting
	if (!hasMigratedUserQueries && settingValue?.globalValue) {
		await configuration.update(QUERIES, addRepoScope(settingValue.globalValue as Query[]), vscode.ConfigurationTarget.Global);
		context.globalState.update(HAS_MIGRATED_QUERIES, true);
	}

	// Workspace setting
	if (!hasMigratedWorkspaceQueries && settingValue?.workspaceValue) {
		await configuration.update(QUERIES, addRepoScope(settingValue.workspaceValue as Query[]), vscode.ConfigurationTarget.Workspace);
		context.workspaceState.update(HAS_MIGRATED_QUERIES, true);
	}
}