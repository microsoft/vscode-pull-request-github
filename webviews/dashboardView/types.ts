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
	readonly repository?: string; // For global dashboard - which repo this session belongs to
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
}

export interface ProjectData {
	readonly name: string;
	readonly path: string;
	readonly lastOpened: string;
}

export type DashboardState = DashboardLoading | DashboardReady | GlobalDashboardLoading | GlobalDashboardReady;

export interface DashboardLoading {
	readonly state: 'loading';
	readonly isGlobal: false;
	readonly issueQuery: string;
}

export interface DashboardReady {
	readonly state: 'ready';
	readonly isGlobal: false;
	readonly issueQuery: string;
	readonly activeSessions: readonly SessionData[];
	readonly milestoneIssues: readonly IssueData[];
}

export interface GlobalDashboardLoading {
	readonly state: 'loading';
	readonly isGlobal: true;
}

export interface GlobalDashboardReady {
	readonly state: 'ready';
	readonly isGlobal: true;
	readonly activeSessions: readonly SessionData[];
	readonly recentProjects: readonly ProjectData[];
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

export const formatFullDateTime = (dateString: string) => {
	if (!dateString) {
		return 'Unknown';
	}

	const date = new Date(dateString);
	return date.toLocaleString();
};

export const extractMilestoneFromQuery = (query: string): string => {
	if (!query) {
		return 'Issues';
	}

	// Try to extract milestone from various formats:
	// milestone:"name" or milestone:'name' or milestone:name
	// Handle quoted milestones with spaces first
	const quotedMatch = query.match(/milestone:["']([^"']+)["']/i);
	if (quotedMatch && quotedMatch[1]) {
		return quotedMatch[1];
	}

	// Handle unquoted milestones (no spaces)
	const milestoneMatch = query.match(/milestone:([^\s]+)/i);
	if (milestoneMatch && milestoneMatch[1]) {
		return milestoneMatch[1];
	}

	// If no milestone found, return generic label
	return 'Issues';
};
