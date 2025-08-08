/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import vscode from 'vscode';
import { CODING_AGENT, CODING_AGENT_AUTO_COMMIT_AND_PUSH, CODING_AGENT_ENABLED, CODING_AGENT_PROMPT_FOR_CONFIRMATION } from './settingKeys';

/**
 * Handles configuration settings for the Copilot Remote Agent
 */
export namespace CopilotRemoteAgentConfig {
	function config() {
		return vscode.workspace.getConfiguration(CODING_AGENT);
	}

	export function getEnabled(): boolean {
		return config().get(CODING_AGENT_ENABLED, false);
	}

	export function getPromptForConfirmation(): boolean {
		return config().get(CODING_AGENT_PROMPT_FOR_CONFIRMATION, true);

	}

	export function getAutoCommitAndPushEnabled(): boolean {
		return config().get(CODING_AGENT_AUTO_COMMIT_AND_PUSH, false);
	}

	export async function disablePromptForConfirmation(): Promise<void> {
		await config().update(CODING_AGENT_PROMPT_FOR_CONFIRMATION, false, vscode.ConfigurationTarget.Global);
	}
}
