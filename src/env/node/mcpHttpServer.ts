/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as crypto from 'crypto';
import * as http from 'http';
import * as vscode from 'vscode';
import Logger from '../../common/logger';
import { McpProtocolHandler, SUPPORTED_PROTOCOL_VERSIONS } from '../../lm/mcp/mcpProtocol';

const MAX_BODY_BYTES = 4 * 1024 * 1024;

export interface McpHttpServerHandle {
	url: string;
	token: string;
	dispose(): void;
}

export async function startMcpHttpServer(
	handler: McpProtocolHandler,
	options: { port?: number } = {},
): Promise<McpHttpServerHandle | undefined> {
	const token = crypto.randomBytes(32).toString('hex');

	return new Promise((resolve, reject) => {
		const server = http.createServer((req, res) => handleRequest(req, res, handler, token));
		server.on('error', reject);
		server.listen(options.port ?? 0, '127.0.0.1', () => {
			const addr = server.address();
			if (!addr || typeof addr === 'string') {
				server.close();
				reject(new Error('MCP server did not bind to a TCP port'));
				return;
			}
			const url = `http://127.0.0.1:${addr.port}/mcp`;
			Logger.appendLine(`MCP server started at ${url}`, 'MCP');
			resolve({
				url,
				token,
				dispose() {
					server.close();
					Logger.appendLine('MCP server stopped', 'MCP');
				},
			});
		});
	});
}

async function handleRequest(
	req: http.IncomingMessage,
	res: http.ServerResponse,
	handler: McpProtocolHandler,
	token: string,
): Promise<void> {
	try {
		const url = new URL(req.url ?? '', `http://${req.headers.host}`);

		if (url.pathname !== '/mcp') {
			res.writeHead(404).end();
			return;
		}

		const host = req.headers.host ?? '';
		if (!isLocalHost(host)) {
			res.writeHead(403).end('Forbidden');
			return;
		}

		const origin = req.headers.origin;
		if (origin !== undefined && !isLocalOrigin(origin)) {
			res.writeHead(403).end('Forbidden');
			return;
		}

		const auth = req.headers.authorization ?? '';
		const expected = Buffer.from(`Bearer ${token}`);
		const actual = Buffer.from(auth);
		if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
			res.writeHead(401, { 'WWW-Authenticate': 'Bearer' }).end('Unauthorized');
			return;
		}

		if (req.method !== 'POST') {
			res.writeHead(405, { Allow: 'POST' }).end();
			return;
		}

		const protoVersion = req.headers['mcp-protocol-version'];
		if (typeof protoVersion === 'string' && !SUPPORTED_PROTOCOL_VERSIONS.includes(protoVersion)) {
			res.writeHead(400, { 'Content-Type': 'application/json' }).end(
				JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: `Unsupported protocol version: ${protoVersion}` } }),
			);
			return;
		}

		const body = await readBody(req);
		if (body === null) {
			res.writeHead(413).end('Request entity too large');
			return;
		}

		let msg: unknown;
		try {
			msg = JSON.parse(body);
		} catch {
			res.writeHead(400, { 'Content-Type': 'application/json' }).end(
				JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }),
			);
			return;
		}

		// Cancel in-flight tool calls if the client disconnects before the response is written.
		const cancellation = new vscode.CancellationTokenSource();
		res.on('close', () => cancellation.cancel());
		try {
			const response = await handler.handleMessage(msg, cancellation.token);

			if (response === undefined) {
				res.writeHead(202).end();
			} else {
				res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(response));
			}
		} finally {
			cancellation.dispose();
		}
	} catch (err) {
		Logger.appendLine(`MCP request error: ${err instanceof Error ? err.message : String(err)}`, 'MCP');
		if (!res.headersSent) {
			res.writeHead(500).end();
		}
	}
}

function isLocalHost(host: string): boolean {
	return /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host);
}

function isLocalOrigin(origin: string): boolean {
	return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin);
}

async function readBody(req: http.IncomingMessage): Promise<string | null> {
	return new Promise(resolve => {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on('data', (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) { resolve(null); req.destroy(); }
			else { chunks.push(chunk); }
		});
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		req.on('error', () => resolve(null));
	});
}
