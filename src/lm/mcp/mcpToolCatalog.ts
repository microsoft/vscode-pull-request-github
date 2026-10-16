/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

export interface McpToolEntry {
	mcpName: string;
	lmToolId: string;
	title: string;
	readOnly: boolean;
}

export const MCP_TOOL_CATALOG: McpToolEntry[] = [
	{ mcpName: 'get_active_pull_request', lmToolId: 'github-pull-request_currentActivePullRequest', title: 'Get Active Pull Request', readOnly: true },
	{ mcpName: 'get_viewed_pull_request', lmToolId: 'github-pull-request_pullRequestInViewport', title: 'Get Viewed Pull Request', readOnly: true },
	{ mcpName: 'get_issue_or_pull_request', lmToolId: 'github-pull-request_issue_fetch', title: 'Get Issue or Pull Request', readOnly: true },
	{ mcpName: 'get_pull_request_status_checks', lmToolId: 'github-pull-request_pullRequestStatusChecks', title: 'Get Pull Request Status Checks', readOnly: true },
	{ mcpName: 'search_issues_and_pull_requests', lmToolId: 'github-pull-request_doSearch', title: 'Search Issues and Pull Requests', readOnly: true },
	{ mcpName: 'list_labels', lmToolId: 'github-pull-request_labels_fetch', title: 'List Labels', readOnly: true },
	{ mcpName: 'get_notification', lmToolId: 'github-pull-request_notification_fetch', title: 'Get Notification', readOnly: true },
	{ mcpName: 'create_pull_request', lmToolId: 'github-pull-request_create_pull_request', title: 'Create Pull Request', readOnly: false },
	{ mcpName: 'resolve_review_thread', lmToolId: 'github-pull-request_resolveReviewThread', title: 'Resolve Review Thread', readOnly: false },
];

export interface McpInputSchema {
	type: string;
	properties?: Record<string, unknown>;
	required?: string[];
}

export interface McpToolDefinition {
	name: string;
	title: string;
	description: string;
	inputSchema: McpInputSchema;
	annotations: {
		readOnlyHint: boolean;
		destructiveHint: boolean;
		openWorldHint: boolean;
	};
}

interface LanguageModelToolContribution {
	name: string;
	displayName?: string;
	modelDescription?: string;
	inputSchema?: McpInputSchema;
}

export interface PackageJsonWithLanguageModelTools {
	contributes?: {
		languageModelTools?: LanguageModelToolContribution[];
	};
}

export function getMcpToolDefinitions(packageJSON: PackageJsonWithLanguageModelTools): McpToolDefinition[] {
	const lmTools = packageJSON.contributes?.languageModelTools ?? [];
	const lmToolMap = new Map<string, LanguageModelToolContribution>(lmTools.map(t => [t.name, t]));

	return MCP_TOOL_CATALOG.map(entry => {
		const lmTool = lmToolMap.get(entry.lmToolId);
		if (!lmTool) {
			throw new Error(`MCP catalog references unknown LM tool: ${entry.lmToolId}`);
		}
		return {
			name: entry.mcpName,
			title: entry.title,
			description: lmTool.modelDescription ?? lmTool.displayName ?? entry.title,
			inputSchema: lmTool.inputSchema ?? { type: 'object', properties: {} },
			annotations: {
				readOnlyHint: entry.readOnly,
				destructiveHint: false,
				openWorldHint: true,
			},
		};
	});
}
