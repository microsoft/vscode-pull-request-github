/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import { MCP_TOOL_CATALOG, McpToolDefinition } from './mcpToolCatalog';

export interface McpCallResult {
	content: Array<{ type: 'text'; text: string }>;
	isError?: boolean;
}

export type McpConfirmFn = (opts: { toolName: string; clientName: string; title: string; message: string }) => Promise<'allow' | 'allowSession' | 'deny'>;

export class McpRpcError extends Error {
	constructor(public readonly code: number, message: string) {
		super(message);
	}
}

export class McpToolBridge {
	private readonly sessionApprovals = new Set<string>();

	constructor(
		private readonly definitions: McpToolDefinition[],
		private readonly tools: Map<string, vscode.LanguageModelTool<unknown>>,
		private readonly confirm: McpConfirmFn = defaultModalConfirm,
	) { }

	listTools(): McpToolDefinition[] {
		return this.definitions;
	}

	async callTool(name: string, args: unknown, clientName: string, token: vscode.CancellationToken): Promise<McpCallResult> {
		const entry = MCP_TOOL_CATALOG.find(e => e.mcpName === name);
		const def = this.definitions.find(d => d.name === name);
		if (!entry || !def) {
			throw new McpRpcError(-32602, `Unknown tool: ${name}`);
		}
		const tool = this.tools.get(entry.lmToolId);
		if (!tool) {
			throw new McpRpcError(-32602, `Tool not available: ${name}`);
		}

		const input = asArgumentRecord(args);
		if (!input) {
			return toolError('Arguments must be a JSON object.');
		}
		const required = def.inputSchema.required ?? [];
		const missing = required.filter(key => input[key] === undefined);
		if (missing.length > 0) {
			return toolError(`Missing required arguments: ${missing.join(', ')}`);
		}

		if (!entry.readOnly && !this.sessionApprovals.has(name)) {
			const message = await this.confirmationMessage(tool, input, `Tool: ${def.title}`, token);
			const decision = await this.confirm({ toolName: name, clientName, title: def.title, message });
			if (decision === 'deny') {
				return toolError(`User denied the request to run "${def.title}".`);
			}
			if (decision === 'allowSession') {
				this.sessionApprovals.add(name);
			}
		}

		try {
			// toolInvocationToken is intentionally undefined: no VS Code language model session exists in the MCP path
			const result = await tool.invoke({ input, toolInvocationToken: undefined }, token);
			const content: McpCallResult['content'] = [];
			for (const part of result?.content ?? []) {
				if (part instanceof vscode.LanguageModelTextPart) {
					content.push({ type: 'text', text: part.value });
				}
			}
			return { content };
		} catch (err) {
			return toolError(errorMessage(err));
		}
	}

	private async confirmationMessage(tool: vscode.LanguageModelTool<unknown>, input: Record<string, unknown>, fallback: string, token: vscode.CancellationToken): Promise<string> {
		try {
			const prepared = await tool.prepareInvocation?.({ input }, token);
			return prepared?.confirmationMessages?.title ?? fallback;
		} catch {
			return fallback;
		}
	}
}

function toolError(text: string): McpCallResult {
	return { isError: true, content: [{ type: 'text', text }] };
}

function asArgumentRecord(args: unknown): Record<string, unknown> | undefined {
	if (args === undefined) {
		return {};
	}
	if (typeof args === 'object' && args !== null && !Array.isArray(args)) {
		return args as Record<string, unknown>;
	}
	return undefined;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

async function defaultModalConfirm(opts: { toolName: string; clientName: string; title: string; message: string }): Promise<'allow' | 'allowSession' | 'deny'> {
	const allow = vscode.l10n.t('Allow');
	const allowSession = vscode.l10n.t('Allow for this session');
	const deny = vscode.l10n.t('Deny');
	const result = await vscode.window.showWarningMessage(
		vscode.l10n.t('MCP client "{0}" wants to run "{1}"', opts.clientName, opts.title),
		{ modal: true, detail: opts.message },
		allow,
		allowSession,
		deny,
	);
	if (result === allow) { return 'allow'; }
	if (result === allowSession) { return 'allowSession'; }
	return 'deny';
}
