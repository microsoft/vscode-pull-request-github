/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface SessionData {
	readonly id: string;
	readonly title: string;
	readonly status: string;
	readonly dateCreated: string;
	readonly isCurrentBranch?: boolean;
	readonly isTemporary?: boolean;
	readonly isLocal?: boolean;
	readonly branchName?: string;
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
	readonly localTaskBranch?: string; // Name of the local task branch if it exists
	readonly pullRequest?: {
		readonly number: number;
		readonly title: string;
		readonly url: string;
	};
}

export type DashboardState = DashboardLoading | DashboardReady;

export interface DashboardLoading {
	readonly state: 'loading';
	readonly issueQuery: string;
}

export interface DashboardReady {
	readonly state: 'ready';
	readonly issueQuery: string;
	readonly activeSessions: readonly SessionData[];
	readonly milestoneIssues: readonly IssueData[];
	readonly repository?: {
		readonly owner: string;
		readonly name: string;
	};
	readonly currentBranch?: string;
}


