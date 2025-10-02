/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

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
