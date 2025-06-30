/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import fetch from 'cross-fetch';
import JSZip from 'jszip';
import * as vscode from 'vscode';
import { AuthProvider } from '../common/authentication';
import Logger from '../common/logger';
import { OctokitCommon } from './common';
import { CredentialStore } from './credentials';
import { LoggingOctokit } from './loggingOctokit';
import { PullRequestModel } from './pullRequestModel';
import { hasEnterpriseUri } from './utils';

const LEARN_MORE_URL = 'https://docs.github.com/en/copilot/how-tos/agents/copilot-coding-agent';
const PREMIUM_REQUESTS_URL = 'https://docs.github.com/en/copilot/concepts/copilot-billing/understanding-and-managing-requests-in-copilot#what-are-premium-requests';

export interface RemoteAgentJobPayload {
	problem_statement: string;
	pull_request?: {
		title?: string;
		body_placeholder?: string;
		body_suffix?: string;
		base_ref?: string;
		head_ref?: string;
	};
	run_name?: string;
}

export interface RemoteAgentJobResponse {
	pull_request: {
		html_url: string;
		number: number;
	}
}

export class CopilotApi {
	protected static readonly ID = 'copilotApi';

	constructor(private octokit: LoggingOctokit, private token: string) { }

	private get baseUrl(): string {
		return 'https://api.githubcopilot.com';
	}

	async postRemoteAgentJob(
		owner: string,
		name: string,
		payload: RemoteAgentJobPayload,
	): Promise<RemoteAgentJobResponse> {
		const repoSlug = `${owner}/${name}`;
		const apiUrl = `${this.baseUrl}/agents/swe/v0/jobs/${repoSlug}`;
		const response = await fetch(apiUrl, {
			method: 'POST',
			headers: {
				'Copilot-Integration-Id': 'copilot-developer-dev',
				'Authorization': `Bearer ${this.token}`,
				'Content-Type': 'application/json',
				'Accept': 'application/json'
			},
			body: JSON.stringify(payload)
		});
		if (!response.ok) {
			throw new Error(await this.formatRemoteAgentJobError(response.status, repoSlug, response));
		}
		const data = await response.json();
		this.validateRemoteAgentJobResponse(data);
		return data;
	}


	// https://github.com/github/sweagentd/blob/371ea6db280b9aecf790ccc20660e39a7ecb8d1c/internal/api/jobapi/handler.go#L110-L120
	private async formatRemoteAgentJobError(status: number, repoSlug: string, response: Response): Promise<string> {
		switch (status) {
			case 400:
				return vscode.l10n.t('Bad request');
			case 401:
				return vscode.l10n.t('Unauthorized');
			case 402:
				return vscode.l10n.t('[Premium request]({0}) quota exceeded', PREMIUM_REQUESTS_URL);
			case 403:
				return vscode.l10n.t('[GitHub Coding Agent]({0}) is not enabled for repository \'{1}\'', LEARN_MORE_URL, repoSlug);
			case 404:
				return vscode.l10n.t('Repository \'{0}\' not found', repoSlug);
			case 409:
				return vscode.l10n.t('A Coding Agent pull request already exists');
			case 500:
				Logger.error(`Server error in remote agent job: ${await response.text()}`, CopilotApi.ID);
				return vscode.l10n.t('Server error. Please try again later.');
			default:
				return vscode.l10n.t('Error: {0}', status);
		}
	}

	private validateRemoteAgentJobResponse(data: any): asserts data is RemoteAgentJobResponse {
		if (!data || typeof data !== 'object') {
			throw new Error('Invalid response from coding agent');
		}
		if (!data.pull_request || typeof data.pull_request !== 'object') {
			throw new Error('Invalid pull_request in response');
		}
		if (typeof data.pull_request.html_url !== 'string') {
			throw new Error('Invalid pull_request.html_url in response');
		}
		if (typeof data.pull_request.number !== 'number') {
			throw new Error('Invalid pull_request.number in response');
		}
	}

	public async getWorkflowRunsFromAction(pullRequest: PullRequestModel): Promise<OctokitCommon.ListWorkflowRunsForRepo> {
		const createdDate = new Date(pullRequest.createdAt);
		const created = `>=${createdDate.getFullYear()}-${String(createdDate.getMonth() + 1).padStart(2, '0')}-${String(createdDate.getDate()).padStart(2, '0')}`;
		const allRuns: any[] = [];
		let page = 1;
		let hasMore = true;
		const per_page = 100;
		while (hasMore) {
			const runs = await this.octokit.api.actions.listWorkflowRunsForRepo({
				owner: pullRequest.remote.owner,
				repo: pullRequest.remote.repositoryName,
				event: 'dynamic',
				created,
				per_page,
				page
			});
			if (runs.status !== 200) {
				throw new Error(`Failed to fetch workflow runs: ${runs.status}`);
			}
			if (Array.isArray(runs.data.workflow_runs)) {
				allRuns.push(...runs.data.workflow_runs);
				hasMore = runs.data.total_count > allRuns.length;
				page++;
			} else {
				hasMore = false;
			}
		}
		// Return only the workflow_runs array for compatibility
		return allRuns as unknown as OctokitCommon.ListWorkflowRunsForRepo;
	}

	public async getLogsFromZipUrl(logsUrl: string): Promise<string[]> {
		const logsZip = await fetch(logsUrl, {
			headers: {
				Authorization: `Bearer ${this.token}`,
				Accept: 'application/json',
			},
		});
		if (!logsZip.ok) {
			throw new Error(`Failed to fetch logs zip: ${logsZip.statusText}`);
		}
		const logsText = await logsZip.arrayBuffer();
		const copilotSteps: string[] = [];
		const zip = await JSZip.loadAsync(logsText);
		for (const fileName of Object.keys(zip.files)) {
			const file = zip.files[fileName];
			if (!file.dir && fileName.endsWith('Processing Request.txt')) {
				const content = await file.async('string');
				copilotSteps.push(...content.split('\n'));
			}
		}
		return copilotSteps;
	}

	public async getAllSessions(pullRequestId: number | undefined): Promise<SessionInfo[]> {
		const response = await fetch(
			pullRequestId
				? `https://api.githubcopilot.com/agents/sessions/resource/pull/${pullRequestId}`
				: 'https://api.githubcopilot.com/agents/sessions',
			{
				headers: {
					Authorization: `Bearer ${this.token}`,
					Accept: 'application/json',
				},
			});
		if (!response.ok) {
			throw new Error(`Failed to fetch sessions: ${response.statusText}`);
		}
		const sessions = await response.json();
		return sessions.sessions;
	}

	public async getSessionInfo(sessionId: string): Promise<SessionInfo> {
		const response = await fetch(`https://api.githubcopilot.com/agents/sessions/${sessionId}`, {
			method: 'GET',
			headers: {
				Authorization: `Bearer ${this.token}`,
				'Accept': 'application/json'
			}
		});
		if (!response.ok) {
			throw new Error(`Failed to fetch session: ${response.statusText}`);
		}

		return (await response.json()) as SessionInfo;
	}

	public async getLogsFromSession(sessionId: string): Promise<string> {
		const logsResponse = await fetch(`https://api.githubcopilot.com/agents/sessions/${sessionId}/logs`, {
			method: 'GET',
			headers: {
				'Authorization': `Bearer ${this.token}`,
				'Content-Type': 'application/json',
			},
		});
		if (!logsResponse.ok) {
			throw new Error(`Failed to fetch logs: ${logsResponse.statusText}`);
		}
		return await logsResponse.text();
	}
}


export interface SessionInfo {
	id: string;
	name: string;
	user_id: number;
	agent_id: number;
	logs: string;
	logs_blob_id: string;
	state: 'completed' | 'in_progress' | string;
	owner_id: number;
	repo_id: number;
	resource_type: string;
	resource_id: number;
	last_updated_at: string;
	created_at: string;
	completed_at: string;
	event_type: string;
	workflow_run_id: number;
	premium_requests: number;
	error: string | null;
}

export async function getCopilotApi(credentialStore: CredentialStore, authProvider?: AuthProvider): Promise<CopilotApi | undefined> {
	if (!authProvider) {
		if (credentialStore.isAuthenticated(AuthProvider.githubEnterprise) && hasEnterpriseUri()) {
			authProvider = AuthProvider.githubEnterprise;
		} else if (credentialStore.isAuthenticated(AuthProvider.github)) {
			authProvider = AuthProvider.github;
		} else {
			return;
		}
	}

	const github = credentialStore.getHub(authProvider);
	if (!github || !github.octokit) {
		return;
	}

	const { token } = await github.octokit.api.auth() as { token: string };
	return new CopilotApi(github.octokit, token);
}