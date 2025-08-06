/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import vscode from 'vscode';
import { CODING_AGENT, CODING_AGENT_AUTO_COMMIT_AND_PUSH, CODING_AGENT_ENABLED, CODING_AGENT_PROMPT_FOR_CONFIRMATION } from '../../common/settingKeys';

/**
 * Handles configuration settings for the Copilot Remote Agent
 */
export class CopilotRemoteAgentConfig {
	private get config() {
		return vscode.workspace.getConfiguration(CODING_AGENT);
	}

	get enabled(): boolean {
		return this.config.get(CODING_AGENT_ENABLED, false);
	}

	get promptForConfirmation(): boolean {
		return this.config.get(CODING_AGENT_PROMPT_FOR_CONFIRMATION, true);
	}

	get autoCommitAndPushEnabled(): boolean {
		return this.config.get(CODING_AGENT_AUTO_COMMIT_AND_PUSH, false);
	}

	async disablePromptForConfirmation(): Promise<void> {
		await this.config.update(CODING_AGENT_PROMPT_FOR_CONFIRMATION, false, vscode.ConfigurationTarget.Global);
	}
}
