/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface SessionData {
	readonly id: string;
	readonly title: string;
	readonly status: string;
	readonly dateCreated: string;
	readonly pullRequest?: {
		readonly number: number;
		readonly title: string;
		readonly url: string;
	};
}

export interface IssueData {
	readonly number: number;
	readonly title: string;
	readonly assignee?: string;
	readonly milestone?: string;
	readonly state: string;
	readonly url: string;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly complexity?: number;
	readonly complexityReasoning?: string;
}

export interface DashboardData {
	readonly activeSessions: readonly SessionData[];
	readonly milestoneIssues: readonly IssueData[];
}

// eslint-disable-next-line rulesdir/no-any-except-union-method-signature
declare let acquireVsCodeApi: any;
export const vscode = acquireVsCodeApi();


export const formatDate = (dateString: string) => {
	if (!dateString) {
		return 'Unknown';
	}

	const date = new Date(dateString);
	return date.toLocaleDateString();
};