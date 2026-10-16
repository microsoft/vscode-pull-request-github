/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import { McpProtocolHandler } from '../../lm/mcp/mcpProtocol';

export interface McpHttpServerHandle {
	url: string;
	token: string;
	dispose(): void;
}

export async function startMcpHttpServer(
	_handler: McpProtocolHandler,
	_options: { port?: number } = {},
): Promise<McpHttpServerHandle | undefined> {
	return undefined;
}
