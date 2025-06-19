/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import fetch from 'cross-fetch';

export interface RemoteAgentJobPayload {
	problem_statement: string;
	pull_request?: {
		title?: string;
		body_placeholder?: string;
		body_suffix?: string;
		base_ref?: string;
	};
	run_name?: string;
}

export class CopilotApi {
	constructor(private token: string) { }

	private get baseUrl(): string {
		return 'https://api.githubcopilot.com';
	}

	async postRemoteAgentJob(
		owner: string,
		name: string,
		payload: RemoteAgentJobPayload,
	): Promise<string> {
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
			throw new Error(`Remote agent API error: ${response.status} ${text}`);
		}
		const data = await response.json();
		return data?.pull_request?.html_url || data?.pull_request?.url;
	}
}
