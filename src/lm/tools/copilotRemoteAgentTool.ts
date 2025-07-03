/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as vscode from 'vscode';
import { CopilotRemoteAgentManager } from '../../github/copilotRemoteAgent';

export interface CopilotRemoteAgentToolParameters {
	// The LLM is inconsistent in providing repo information.
	// For now, we only support the active repository in the current workspace.
	// repo?: {
	// 	owner?: string;
	// 	name?: string;
	// };
	title: string;
	body?: string;
	existingPullRequest?: string;
}

export class CopilotRemoteAgentTool implements vscode.LanguageModelTool<CopilotRemoteAgentToolParameters> {
	public static readonly toolId = 'github-pull-request_copilot-coding-agent';

	constructor(private manager: CopilotRemoteAgentManager) { }

	async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<CopilotRemoteAgentToolParameters>): Promise<vscode.PreparedToolInvocation> {
		const { title, existingPullRequest } = options.input;

		// Check if the coding agent is available (enabled and assignable)
		const isAvailable = await this.manager.isAvailable();
		if (!isAvailable) {
			throw new Error(vscode.l10n.t('Copilot coding agent is not available for this repository. Make sure the agent is enabled and assignable to this repository.'));
		}

		const targetRepo = await this.manager.repoInfo();
		const autoPushEnabled = this.manager.autoCommitAndPushEnabled();
		return {
			pastTenseMessage: vscode.l10n.t('Launched coding agent'),
			invocationMessage: vscode.l10n.t('Launching coding agent'),
			confirmationMessages: {
				message: existingPullRequest
					? vscode.l10n.t('The coding agent will incorporate your feedback on existing pull request **#{0}**.', existingPullRequest)
					: (targetRepo && autoPushEnabled
						? vscode.l10n.t('The coding agent will continue work on "**{0}**" in a new branch on "**{1}/{2}**". Any uncommitted changes will be **automatically pushed**.', title, targetRepo.owner, targetRepo.repo)
						: vscode.l10n.t('The coding agent will start working on "**{0}**"', title)),
				title: vscode.l10n.t('Start coding agent?'),
			}
		};
	}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<CopilotRemoteAgentToolParameters>,
		_: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult | undefined> {
		const title = options.input.title;
		const body = options.input.body || '';
		const existingPullRequest = options.input.existingPullRequest || '';
		const targetRepo = await this.manager.repoInfo();
		if (!targetRepo) {
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(vscode.l10n.t('No repository information found. Please open a workspace with a Git repository.'))
			]);
		}

		let pullRequestNumber: number | undefined;
		if (existingPullRequest) {
			pullRequestNumber = parseInt(existingPullRequest, 10);
			if (isNaN(pullRequestNumber)) {
				return new vscode.LanguageModelToolResult([
					new vscode.LanguageModelTextPart(vscode.l10n.t('Invalid pull request number: {0}', existingPullRequest))
				]);
			}
		} else {
			const { repo, owner } = targetRepo;
			const activePR = targetRepo.fm.activePullRequest;
			if (activePR && this.manager.getStateForPR(owner, repo, activePR.number)) {
				pullRequestNumber = activePR.number;
			}
		}

		if (pullRequestNumber) {
			await this.manager.addFollowUpToExistingPR(pullRequestNumber, title, body);
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(vscode.l10n.t('Follow-up added to pull request #{0}.', pullRequestNumber)),
			]);
		}

		const result = await this.manager.invokeRemoteAgent(title, body);
		if (result.state === 'error') {
			throw new Error(result.error);
		}
		return new vscode.LanguageModelToolResult([
			new vscode.LanguageModelTextPart(result.llmDetails)
		]);
	}
}