/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import { McpRpcError, McpToolBridge } from './mcpToolBridge';

export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];

interface JsonRpcRequest {
	jsonrpc: '2.0';
	id?: string | number | null;
	method: string;
	params?: unknown;
}

interface JsonRpcResponse {
	jsonrpc: '2.0';
	id: string | number | null;
	result?: unknown;
	error?: { code: number; message: string };
}

export class McpProtocolHandler {
	private clientName = 'unknown';

	constructor(private readonly bridge: McpToolBridge, private readonly serverVersion: string) { }

	async handleMessage(msg: unknown, token: vscode.CancellationToken): Promise<JsonRpcResponse | undefined> {
		if (Array.isArray(msg)) {
			return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Batch requests not supported' } };
		}
		if (!isJsonRpcRequest(msg)) {
			return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid JSON-RPC message' } };
		}
		const { id, method, params } = msg;
		const isNotification = id === undefined;

		try {
			const result = await this.dispatch(method, params, token);
			if (result === undefined || isNotification) {
				return undefined;
			}
			return { jsonrpc: '2.0', id: id ?? null, result };
		} catch (err) {
			if (isNotification) {
				return undefined;
			}
			const code = err instanceof McpRpcError ? err.code : -32603;
			const message = err instanceof Error ? err.message : String(err);
			return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
		}
	}

	private async dispatch(method: string, params: unknown, token: vscode.CancellationToken): Promise<unknown> {
		const p = asRecord(params);
		switch (method) {
			case 'initialize': {
				const requested = p['protocolVersion'];
				const protocolVersion = typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
					? requested
					: SUPPORTED_PROTOCOL_VERSIONS[0];
				this.clientName = clientNameOf(p['clientInfo']);
				return {
					protocolVersion,
					capabilities: { tools: { listChanged: false } },
					serverInfo: { name: 'github-pull-requests', version: this.serverVersion },
					instructions: 'Tools for interacting with GitHub pull requests and issues via the VS Code GitHub Pull Requests extension.',
				};
			}
			case 'ping':
				return {};
			case 'tools/list':
				return { tools: this.bridge.listTools() };
			case 'tools/call': {
				const name = p['name'];
				if (typeof name !== 'string') {
					throw new McpRpcError(-32602, 'tools/call requires a "name" parameter');
				}
				return this.bridge.callTool(name, p['arguments'], this.clientName, token);
			}
			default:
				if (method.startsWith('notifications/')) {
					return undefined;
				}
				throw new McpRpcError(-32601, `Method not found: ${method}`);
		}
	}
}

function isJsonRpcRequest(msg: unknown): msg is JsonRpcRequest {
	if (typeof msg !== 'object' || msg === null) {
		return false;
	}
	const candidate = msg as Partial<JsonRpcRequest>;
	return candidate.jsonrpc === '2.0' && typeof candidate.method === 'string';
}

function asRecord(value: unknown): Record<string, unknown> {
	if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	return {};
}

function clientNameOf(clientInfo: unknown): string {
	const name = asRecord(clientInfo)['name'];
	return typeof name === 'string' ? name : 'unknown';
}
