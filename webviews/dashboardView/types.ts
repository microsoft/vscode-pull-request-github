/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface SessionData {
	id: string;
	title: string;
	status: string;
	dateCreated: string;
	pullRequest?: {
		number: number;
		title: string;
		url: string;
	};
}

export interface IssueData {
	number: number;
	title: string;
	assignee?: string;
	milestone?: string;
	state: string;
	url: string;
	createdAt: string;
	updatedAt: string;
	complexity?: number;
	complexityReasoning?: string;
}

export interface DashboardData {
	activeSessions: SessionData[];
	milestoneIssues: IssueData[];
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