/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import fetch from 'cross-fetch';
import * as vscode from 'vscode';
import { CredentialStore } from './credentials';
import { LoggingOctokit } from './loggingOctokit';
import { hasEnterpriseUri } from './utils';
import { AuthProvider } from '../common/authentication';
import Logger from '../common/logger';
import { ITelemetry } from '../common/telemetry';

/**
 * This is temporary for the migration of CCA only.
 * Once fully migrated we can rename to ChatSessionWithPR and remove the old one.
 **/
export interface CrossChatSessionWithPR extends vscode.ChatSessionItem {
	pullRequestDetails: {
		id: string;
		number: number;
		repository: {
			owner: {
				login: string;
			};
			name: string;
		};
	};
}

export class CopilotApi {
	protected static readonly ID = 'copilotApi';

	constructor(
		private octokit: LoggingOctokit,
		private token: string,
		private telemetry: ITelemetry
	) { }

	private get baseUrl(): string {
		return 'https://api.githubcopilot.com';
	}

	private async makeApiCallFullUrl(url: string, init: RequestInit): Promise<Response> {
		const apiCall = () => fetch(url, init);
		return this.octokit.call(apiCall);
	}
	private async makeApiCall(api: string, init: RequestInit): Promise<Response> {
		return this.makeApiCallFullUrl(`${this.baseUrl}${api}`, init);
	}

	public async getAllSessions(pullRequestId: number | undefined): Promise<SessionInfo[]> {
		const response = await this.makeApiCall(
			pullRequestId
				? `/agents/sessions/resource/pull/${pullRequestId}`
				: `/agents/sessions`,
			{
				headers: {
					Authorization: `Bearer ${this.token}`,
					Accept: 'application/json',
				},
			});
		if (!response.ok) {
			await this.handleApiError(response, 'getAllSessions');
		}
		const sessions = await response.json();
		return sessions.sessions;
	}

	private async handleApiError(response: Response, action: string): Promise<never> {
		let errorBody: string | undefined = undefined;
		try {
			errorBody = await response.text();
		} catch (e) { /* ignore */ }
		const msg = `'${action}' failed with ${response.statusText} ${errorBody ? `: ${errorBody}` : ''}`;
		Logger.error(msg, CopilotApi.ID);

		/* __GDPR__
			"remoteAgent.apiError" : {
				"action" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" },
				"status" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" },
				"body" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" }
			}
		*/
		this.telemetry.sendTelemetryErrorEvent('remoteAgent.apiError', {
			action,
			status: response.status.toString(),
			body: errorBody || '',
		});

		throw new Error(msg);
	}
}


export interface SessionInfo {
	id: string;
	name: string;
	user_id: number;
	agent_id: number;
	logs: string;
	logs_blob_id: string;
	state: 'completed' | 'in_progress' | 'failed' | 'queued';
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

export async function getCopilotApi(credentialStore: CredentialStore, telemetry: ITelemetry, authProvider?: AuthProvider): Promise<CopilotApi | undefined> {
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
	return new CopilotApi(github.octokit, token, telemetry);
}