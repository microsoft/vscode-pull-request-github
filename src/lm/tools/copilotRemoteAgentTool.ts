/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as vscode from 'vscode';
import { CopilotRemoteAgentManager, CopilotRemoteAgentMode } from '../../github/copilotRemoteAgent';

export interface CopilotRemoteAgentToolParameters {
	repo?: {
		owner?: string;
		name?: string;
	};
	title: string;
	body?: string;
	// mode?: 'issue' | 'remote-agent' | 'continue';
}

export class CopilotRemoteAgentTool implements vscode.LanguageModelTool<CopilotRemoteAgentToolParameters> {
	public static readonly toolId = 'github-pull-request_copilot-coding-agent';

	constructor(private service: CopilotRemoteAgentManager) { }

	async prepareInvocation(): Promise<vscode.PreparedToolInvocation> {
		return {
			invocationMessage: vscode.l10n.t('Delegating task to Copilot'),
		};
	}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<CopilotRemoteAgentToolParameters>,
		_: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult | undefined> {
		const repo = options.input.repo;
		let owner = repo?.owner;
		let name = repo?.name;
		const title = options.input.title;
		const body = options.input.body || '';

		let mode: CopilotRemoteAgentMode = CopilotRemoteAgentMode.Default;
		// Use first folder manager as fallback for owner/repo
		const fm = this.service.repositoriesManager.folderManagers[0];

		const ignoreModelInterredRepoEntirelyTODO = true;
		if (ignoreModelInterredRepoEntirelyTODO || !repo || !owner) {
			if (!fm) {
				return new vscode.LanguageModelToolResult([
					new vscode.LanguageModelTextPart(
						'No folder manager found. Make sure to have a repository open or specify your target \'owner/repo\''
					),
				]);
			}
			const defaults = await fm.getPullRequestDefaults();
			if (defaults) {
				owner = defaults.owner;
				name = defaults.repo;
			}
		}

		if (!owner || !name || !title) {
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(
					'Missing required repo, owner, name, or title.'
				),
			]);
		}
		if (fm) {
			const state = fm.repository.state;
			if (state.workingTreeChanges.length > 0 || state.indexChanges.length > 0) {
				mode = CopilotRemoteAgentMode.Continue;
			}
		}
		try {
			const prUrl = await this.service.invokeRemoteAgent(owner, name, title, body, mode);
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
