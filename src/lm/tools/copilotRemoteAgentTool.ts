/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as vscode from 'vscode';
import { CopilotRemoteAgentManager, CopilotRemoteAgentMode } from '../../github/copilotRemoteAgent';

export interface CopilotRemoteAgentToolParameters {
	// The LLM is inconsistent in providing repo information.
	// For now, we only support the active repository in the current workspace.
	// repo?: {
	// 	owner?: string;
	// 	name?: string;
	// };
	title: string;
	body?: string;
	// mode?: 'issue' | 'remote-agent' | 'continue';
}

export class CopilotRemoteAgentTool implements vscode.LanguageModelTool<CopilotRemoteAgentToolParameters> {
	public static readonly toolId = 'github-pull-request_copilot-coding-agent';

	constructor(private manager: CopilotRemoteAgentManager) { }

	async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<CopilotRemoteAgentToolParameters>): Promise<vscode.PreparedToolInvocation> {
		const { title } = options.input;
		const targetRepo = await this.manager.targetRepo();
		return {
			invocationMessage: vscode.l10n.t('Delegating task to coding agent'),
			confirmationMessages: {
				message: targetRepo
					? vscode.l10n.t('Your in-progress changes will be pushed to \'{0}/{1}\' for the coding agent to continue working on \'{2}\'', targetRepo.owner, targetRepo.repo, title)
					: vscode.l10n.t('TODO'),
				title: vscode.l10n.t('Allow coding agent to continue working?'),
			}
		};
	}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<CopilotRemoteAgentToolParameters>,
		_: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult | undefined> {
		// const repo = options.input.repo;
		// let owner = repo?.owner;
		// let name = repo?.name;
		const title = options.input.title;
		const body = options.input.body || '';

		let mode: CopilotRemoteAgentMode = CopilotRemoteAgentMode.Default;
		// Use first folder manager as fallback for owner/repo
		const fm = this.manager.repositoriesManager.folderManagers[0];
		if (fm) {
			const state = fm.repository.state;
			if (state.workingTreeChanges.length > 0 || state.indexChanges.length > 0) {
				mode = CopilotRemoteAgentMode.Continue;
			}
		}

		const targetRepo = await this.manager.targetRepo();
		if (!targetRepo) {
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(vscode.l10n.t('No repository informationfound. Please open a workspace with a Git repository.'))
			]);
		}

		try {
			const prUrl = await this.manager.invokeRemoteAgent(targetRepo.owner, targetRepo.repo, title, body, mode);
			if (!prUrl) {
				throw new Error('Failed to start remote agent. Please try again later.');
			}
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(prUrl)
			]);
		} catch (e: any) {
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(e.message)
			]);
		}
	}
}
