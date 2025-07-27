/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as vscode from 'vscode';
import { COPILOT_ACCOUNTS } from '../../common/comment';
import { ITelemetry } from '../../common/telemetry';
import { toOpenPullRequestWebviewUri } from '../../common/uri';
import { CopilotRemoteAgentManager } from '../../github/copilotRemoteAgent';
import { FolderRepositoryManager } from '../../github/folderRepositoryManager';

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

	constructor(private manager: CopilotRemoteAgentManager, private telemetry: ITelemetry) { }

	async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<CopilotRemoteAgentToolParameters>): Promise<vscode.PreparedToolInvocation> {
		const { title, existingPullRequest } = options.input;

		// Check if the coding agent is available (enabled and assignable)
		const isAvailable = await this.manager.isAvailable();
		if (!isAvailable) {
			throw new Error(vscode.l10n.t('Copilot coding agent is not available for this repository. Make sure the agent is enabled and assignable to this repository.'));
		}

		const targetRepo = await this.manager.repoInfo();
		const autoPushEnabled = this.manager.autoCommitAndPushEnabled();
		const openPR = existingPullRequest || await this.getActivePullRequestWithSession(targetRepo);

		/* __GDPR__
			"remoteAgent.tool.prepare" : {}
		*/
		this.telemetry.sendTelemetryEvent('copilot.remoteAgent.tool.prepare', {});

		return {
			pastTenseMessage: vscode.l10n.t('Launched coding agent'),
			invocationMessage: vscode.l10n.t('Launching coding agent'),
			confirmationMessages: {
				message: openPR
					? vscode.l10n.t('The coding agent will incorporate your feedback on existing pull request **#{0}**.', openPR)
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
			pullRequestNumber = await this.getActivePullRequestWithSession(targetRepo);
		}

		/* __GDPR__
			"copilot.remoteAgent.tool.invoke" : {
				"hasExistingPR" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" },
				"hasBody" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" }
			}
		*/
		this.telemetry.sendTelemetryEvent('copilot.remoteAgent.tool.invoke', {
			hasExistingPR: pullRequestNumber ? 'true' : 'false',
			hasBody: body ? 'true' : 'false'
		});

		if (pullRequestNumber) {
			await this.manager.addFollowUpToExistingPR(pullRequestNumber, title, body);
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(vscode.l10n.t('Follow-up added to pull request #{0}.', pullRequestNumber)),
			]);
		}

		const result = await this.manager.invokeRemoteAgent(title, body);
		if (result.state === 'error') {
			/* __GDPR__
				"copilot.remoteAgent.tool.error" : {
					"reason" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" }
				}
			*/
			this.telemetry.sendTelemetryErrorEvent('copilot.remoteAgent.tool.error', { reason: 'invocationError' });
			throw new Error(result.error);
		}

		let lmResult: (vscode.LanguageModelTextPart | vscode.LanguageModelDataPart)[] = [new vscode.LanguageModelTextPart(result.llmDetails)];
		const pr = await targetRepo.fm.resolvePullRequest(targetRepo.owner, targetRepo.repo, result.number);
		if (pr) {
			const preferredRendering = {
				uri: (await toOpenPullRequestWebviewUri({ owner: pr.githubRepository.remote.owner, repo: pr.githubRepository.remote.repositoryName, pullRequestNumber: pr.number })).toString(),
				title: pr.title,
				description: pr.body,
				author: COPILOT_ACCOUNTS[pr.author.login].name,
				linkTag: `#${pr.number}`
			};
			const buffer: Buffer = Buffer.from(JSON.stringify(preferredRendering));
			const data: Uint8Array = Uint8Array.from(buffer);
			lmResult.push(new vscode.LanguageModelDataPart2(data, 'application/pull-request+json', [vscode.ToolResultAudience.User]));
		}

		return new vscode.LanguageModelToolResult2(lmResult);
	}

	private async getActivePullRequestWithSession(repoInfo: { repo: string; owner: string; fm: FolderRepositoryManager } | undefined): Promise<number | undefined> {
		if (!repoInfo) {
			return;
		}
		const activePR = repoInfo.fm.activePullRequest;
		if (activePR && this.manager.getStateForPR(repoInfo.owner, repoInfo.repo, activePR.number)) {
			return activePR.number;
		}
	}
}