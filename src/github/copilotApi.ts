/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import fetch from 'cross-fetch';
import JSZip from 'jszip';
import { AuthProvider } from '../common/authentication';
import { Remote } from '../common/remote';
import { OctokitCommon } from './common';
import { CredentialStore } from './credentials';
import { LoggingOctokit } from './loggingOctokit';
import { hasEnterpriseUri } from './utils';

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
		const apiUrl = `${this.baseUrl}/agents/swe/jobs/${repoSlug}`;
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
			const text = await response.text();
			throw new Error(`Coding agent API error: ${response.status} ${text}`);
		}
		const data = await response.json();
		this.validateRemoteAgentJobResponse(data);
		return data;
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

	public async getWorkflowRunsFromAction(remote: Remote): Promise<OctokitCommon.ListWorkflowRunsForRepo> {
		const runs = await this.octokit.api.actions.listWorkflowRunsForRepo(
			{
				owner: remote.owner,
				repo: remote.repositoryName,
				event: 'dynamic'
			}
		);
		if (runs.status !== 200) {
			throw new Error(`Failed to fetch workflow runs: ${runs.status}`);
		}
		return runs.data.workflow_runs;
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