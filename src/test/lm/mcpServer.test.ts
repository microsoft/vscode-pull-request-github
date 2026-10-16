/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import * as http from 'http';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { startMcpHttpServer, McpHttpServerHandle } from '../../env/node/mcpHttpServer';
import { EXTENSION_ID } from '../../constants';
import { McpProtocolHandler, SUPPORTED_PROTOCOL_VERSIONS } from '../../lm/mcp/mcpProtocol';
import { getMcpToolDefinitions, MCP_TOOL_CATALOG, McpToolDefinition, PackageJsonWithLanguageModelTools } from '../../lm/mcp/mcpToolCatalog';
import { McpRpcError, McpToolBridge } from '../../lm/mcp/mcpToolBridge';

const ISSUE_FETCH_TOOL_ID = 'github-pull-request_issue_fetch';
const RESOLVE_THREAD_TOOL_ID = 'github-pull-request_resolveReviewThread';

interface FakeTool {
	tool: vscode.LanguageModelTool<unknown>;
	invoke: sinon.SinonStub;
	prepareInvocation: sinon.SinonStub;
}

function fakeTool(behavior: { text?: string; error?: Error; confirmationTitle?: string } = {}): FakeTool {
	const invoke = sinon.stub().callsFake(async () => {
		if (behavior.error) {
			throw behavior.error;
		}
		return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(behavior.text ?? 'ok')]);
	});
	const prepareInvocation = sinon.stub().callsFake(async () => ({
		invocationMessage: 'Working',
		confirmationMessages: behavior.confirmationTitle ? { title: behavior.confirmationTitle, message: 'details' } : undefined,
	}));
	const tool: vscode.LanguageModelTool<unknown> = { invoke, prepareInvocation };
	return { tool, invoke, prepareInvocation };
}

function cancellationToken(): vscode.CancellationToken {
	return new vscode.CancellationTokenSource().token;
}

function getPackageJSON(): PackageJsonWithLanguageModelTools {
	const extension = vscode.extensions.getExtension(EXTENSION_ID);
	assert.ok(extension, 'extension must be available in the test host');
	return extension.packageJSON;
}

describe('MCP catalog', () => {
	it('maps every catalog entry to a language model tool declared in package.json', () => {
		const packageJSON = getPackageJSON();
		const declared = new Set((packageJSON.contributes?.languageModelTools ?? []).map(t => t.name));
		for (const entry of MCP_TOOL_CATALOG) {
			assert.ok(declared.has(entry.lmToolId), `${entry.lmToolId} is not declared in package.json`);
		}
		assert.strictEqual(getMcpToolDefinitions(packageJSON).length, MCP_TOOL_CATALOG.length);
	});

	it('throws when a catalog entry references an undeclared tool', () => {
		assert.throws(() => getMcpToolDefinitions({ contributes: { languageModelTools: [] } }), /unknown LM tool/);
	});
});

describe('MCP protocol handler', () => {
	let definitions: McpToolDefinition[];
	let handler: McpProtocolHandler;

	beforeEach(() => {
		definitions = getMcpToolDefinitions(getPackageJSON());
		handler = new McpProtocolHandler(new McpToolBridge(definitions, new Map()), '1.2.3');
	});

	it('echoes a supported protocol version on initialize', async () => {
		const response = await handler.handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'test-client' } } }, cancellationToken());
		assert.strictEqual(response?.id, 1);
		const result = response?.result as { protocolVersion: string; serverInfo: { version: string } };
		assert.strictEqual(result.protocolVersion, '2025-06-18');
		assert.strictEqual(result.serverInfo.version, '1.2.3');
	});

	it('falls back to the newest supported protocol version for unknown versions', async () => {
		const response = await handler.handleMessage({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } }, cancellationToken());
		const result = response?.result as { protocolVersion: string };
		assert.strictEqual(result.protocolVersion, SUPPORTED_PROTOCOL_VERSIONS[0]);
	});

	it('answers ping with an empty result', async () => {
		const response = await handler.handleMessage({ jsonrpc: '2.0', id: 3, method: 'ping' }, cancellationToken());
		assert.deepStrictEqual(response, { jsonrpc: '2.0', id: 3, result: {} });
	});

	it('lists every catalog tool', async () => {
		const response = await handler.handleMessage({ jsonrpc: '2.0', id: 4, method: 'tools/list' }, cancellationToken());
		const result = response?.result as { tools: McpToolDefinition[] };
		assert.strictEqual(result.tools.length, MCP_TOOL_CATALOG.length);
	});

	it('returns method not found for unknown methods', async () => {
		const response = await handler.handleMessage({ jsonrpc: '2.0', id: 5, method: 'resources/list' }, cancellationToken());
		assert.strictEqual(response?.error?.code, -32601);
	});

	it('does not respond to notifications', async () => {
		const response = await handler.handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, cancellationToken());
		assert.strictEqual(response, undefined);
	});

	it('does not respond to unknown notifications', async () => {
		const response = await handler.handleMessage({ jsonrpc: '2.0', method: 'notifications/unknown' }, cancellationToken());
		assert.strictEqual(response, undefined);
	});

	it('rejects batch requests and malformed messages', async () => {
		const batch = await handler.handleMessage([{ jsonrpc: '2.0', id: 1, method: 'ping' }], cancellationToken());
		assert.strictEqual(batch?.error?.code, -32600);
		const malformed = await handler.handleMessage({ id: 1, method: 'ping' }, cancellationToken());
		assert.strictEqual(malformed?.error?.code, -32600);
	});
});

describe('MCP tool bridge', () => {
	let definitions: McpToolDefinition[];

	beforeEach(() => {
		definitions = getMcpToolDefinitions(getPackageJSON());
	});

	it('invokes read-only tools without asking for confirmation', async () => {
		const fake = fakeTool({ text: 'issue #1' });
		const confirm = sinon.stub().resolves('allow');
		const bridge = new McpToolBridge(definitions, new Map([[ISSUE_FETCH_TOOL_ID, fake.tool]]), confirm);

		const result = await bridge.callTool('get_issue_or_pull_request', { issueNumber: 1 }, 'test-client', cancellationToken());

		assert.deepStrictEqual(result, { content: [{ type: 'text', text: 'issue #1' }] });
		assert.strictEqual(confirm.called, false);
		assert.strictEqual(fake.invoke.calledOnce, true);
	});

	it('denies write tools when the user declines', async () => {
		const fake = fakeTool({ confirmationTitle: 'Resolve thread?' });
		const confirm = sinon.stub().resolves('deny');
		const bridge = new McpToolBridge(definitions, new Map([[RESOLVE_THREAD_TOOL_ID, fake.tool]]), confirm);

		const result = await bridge.callTool('resolve_review_thread', { threadId: 'abc' }, 'test-client', cancellationToken());

		assert.strictEqual(result.isError, true);
		assert.strictEqual(fake.invoke.called, false);
		assert.strictEqual(confirm.calledOnce, true);
		assert.strictEqual(confirm.firstCall.args[0].message, 'Resolve thread?');
	});

	it('asks again for each write call when the user allows only once', async () => {
		const fake = fakeTool();
		const confirm = sinon.stub().resolves('allow');
		const bridge = new McpToolBridge(definitions, new Map([[RESOLVE_THREAD_TOOL_ID, fake.tool]]), confirm);

		await bridge.callTool('resolve_review_thread', { threadId: 'abc' }, 'test-client', cancellationToken());
		await bridge.callTool('resolve_review_thread', { threadId: 'abc' }, 'test-client', cancellationToken());

		assert.strictEqual(confirm.callCount, 2);
		assert.strictEqual(fake.invoke.callCount, 2);
	});

	it('remembers session approval for a write tool', async () => {
		const fake = fakeTool();
		const confirm = sinon.stub().resolves('allowSession');
		const bridge = new McpToolBridge(definitions, new Map([[RESOLVE_THREAD_TOOL_ID, fake.tool]]), confirm);

		await bridge.callTool('resolve_review_thread', { threadId: 'abc' }, 'test-client', cancellationToken());
		await bridge.callTool('resolve_review_thread', { threadId: 'def' }, 'test-client', cancellationToken());

		assert.strictEqual(confirm.calledOnce, true);
		assert.strictEqual(fake.invoke.callCount, 2);
	});

	it('reports tool failures as error results', async () => {
		const fake = fakeTool({ error: new Error('boom') });
		const bridge = new McpToolBridge(definitions, new Map([[ISSUE_FETCH_TOOL_ID, fake.tool]]));

		const result = await bridge.callTool('get_issue_or_pull_request', { issueNumber: 1 }, 'test-client', cancellationToken());

		assert.deepStrictEqual(result, { isError: true, content: [{ type: 'text', text: 'boom' }] });
	});

	it('reports missing required arguments without invoking the tool', async () => {
		const fake = fakeTool();
		const bridge = new McpToolBridge(definitions, new Map([[ISSUE_FETCH_TOOL_ID, fake.tool]]));

		const result = await bridge.callTool('get_issue_or_pull_request', {}, 'test-client', cancellationToken());

		assert.strictEqual(result.isError, true);
		assert.strictEqual(result.content[0].text, 'Missing required arguments: issueNumber');
		assert.strictEqual(fake.invoke.called, false);
	});

	it('rejects unknown tool names with an invalid params error', async () => {
		const bridge = new McpToolBridge(definitions, new Map());

		await assert.rejects(
			bridge.callTool('does_not_exist', {}, 'test-client', cancellationToken()),
			(err: unknown) => err instanceof McpRpcError && err.code === -32602,
		);
	});
});

describe('MCP HTTP server', () => {
	let handle: McpHttpServerHandle;

	before(async () => {
		const definitions = getMcpToolDefinitions(getPackageJSON());
		const started = await startMcpHttpServer(new McpProtocolHandler(new McpToolBridge(definitions, new Map()), '1.2.3'));
		if (!started) {
			throw new Error('MCP HTTP server did not start');
		}
		handle = started;
	});

	after(() => {
		handle.dispose();
	});

	interface RequestOptions {
		method?: string;
		path?: string;
		headers?: http.OutgoingHttpHeaders;
		withAuth?: boolean;
		body?: string;
	}

	function send(options: RequestOptions = {}): Promise<{ status: number; body: string }> {
		const port = new URL(handle.url).port;
		const headers: http.OutgoingHttpHeaders = { 'Content-Type': 'application/json', ...options.headers };
		if (options.withAuth !== false && headers.Authorization === undefined) {
			headers.Authorization = `Bearer ${handle.token}`;
		}
		return new Promise((resolve, reject) => {
			const req = http.request({
				host: '127.0.0.1',
				port,
				path: options.path ?? '/mcp',
				method: options.method ?? 'POST',
				headers,
			}, res => {
				const chunks: Buffer[] = [];
				res.on('data', (chunk: Buffer) => chunks.push(chunk));
				res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
			});
			req.on('error', reject);
			req.end(options.body);
		});
	}

	const initializeBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } });

	it('rejects requests without the bearer token', async () => {
		const res = await send({ withAuth: false, body: initializeBody });
		assert.strictEqual(res.status, 401);
	});

	it('rejects requests with the wrong bearer token', async () => {
		const res = await send({ headers: { Authorization: 'Bearer not-the-token' }, body: initializeBody });
		assert.strictEqual(res.status, 401);
	});

	it('rejects non-loopback Host headers', async () => {
		const res = await send({ headers: { Host: 'evil.example' }, body: initializeBody });
		assert.strictEqual(res.status, 403);
	});

	it('rejects non-loopback Host headers before checking the bearer token', async () => {
		const res = await send({ withAuth: false, headers: { Host: 'evil.example' }, body: initializeBody });
		assert.strictEqual(res.status, 403);
	});

	it('rejects non-loopback Origin headers', async () => {
		const res = await send({ headers: { Origin: 'https://evil.example' }, body: initializeBody });
		assert.strictEqual(res.status, 403);
	});

	it('rejects methods other than POST', async () => {
		const res = await send({ method: 'GET' });
		assert.strictEqual(res.status, 405);
	});

	it('rejects unsupported MCP-Protocol-Version headers', async () => {
		const res = await send({ headers: { 'MCP-Protocol-Version': '1999-01-01' }, body: initializeBody });
		assert.strictEqual(res.status, 400);
	});

	it('returns 404 for paths other than /mcp', async () => {
		const res = await send({ path: '/other', body: initializeBody });
		assert.strictEqual(res.status, 404);
	});

	it('returns a parse error for invalid JSON', async () => {
		const res = await send({ body: '{' });
		assert.strictEqual(res.status, 400);
		assert.strictEqual((JSON.parse(res.body) as { error: { code: number } }).error.code, -32700);
	});

	it('answers initialize over an authorized POST', async () => {
		const res = await send({ body: initializeBody });
		assert.strictEqual(res.status, 200);
		const parsed = JSON.parse(res.body) as { id: number; result: { protocolVersion: string } };
		assert.strictEqual(parsed.id, 1);
		assert.strictEqual(parsed.result.protocolVersion, '2025-11-25');
	});

	it('acknowledges notifications with 202 and no body', async () => {
		const res = await send({ body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
		assert.strictEqual(res.status, 202);
		assert.strictEqual(res.body, '');
	});
});
