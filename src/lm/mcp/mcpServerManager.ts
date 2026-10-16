/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import { McpProtocolHandler } from './mcpProtocol';
import { McpToolBridge } from './mcpToolBridge';
import { getMcpToolDefinitions } from './mcpToolCatalog';
import { Disposable } from '../../common/lifecycle';
import Logger from '../../common/logger';
import { EXPERIMENTAL_MCP_SERVER } from '../../common/settingKeys';
import { McpHttpServerHandle, startMcpHttpServer } from '../../env/node/mcpHttpServer';
import { CredentialStore } from '../../github/credentials';
import { RepositoriesManager } from '../../github/repositoriesManager';
import { createTools } from '../tools/tools';

const SETTING_KEY = `githubPullRequests.${EXPERIMENTAL_MCP_SERVER}`;

export class McpServerManager extends Disposable {
	private serverHandle: McpHttpServerHandle | undefined;
	private providerRegistration: vscode.Disposable | undefined;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly credentialStore: CredentialStore,
		private readonly reposManager: RepositoriesManager,
	) {
		super();

		this._register(vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(SETTING_KEY)) {
				this.syncServer();
			}
		}));

		this._register(vscode.workspace.onDidGrantWorkspaceTrust(() => this.syncServer()));

		this._register(vscode.commands.registerCommand('pr.copyMcpServerConfig', () => this.copyConfig()));

		this.syncServer();
	}

	private async syncServer(): Promise<void> {
		const enabled = vscode.workspace.getConfiguration().get<boolean>(SETTING_KEY, false);
		const trusted = vscode.workspace.isTrusted;

		if (enabled && trusted && !this.serverHandle) {
			await this.startServer();
		} else if ((!enabled || !trusted) && this.serverHandle) {
			this.stopServer();
		}
	}

	private async startServer(): Promise<void> {
		try {
			const tools = createTools(this.credentialStore, this.reposManager);
			const definitions = getMcpToolDefinitions(this.context.extension.packageJSON);
			const bridge = new McpToolBridge(definitions, tools);
			const version: string = this.context.extension.packageJSON.version ?? '0.0.0';
			const handler = new McpProtocolHandler(bridge, version);

			this.serverHandle = await startMcpHttpServer(handler);
			if (!this.serverHandle) {
				Logger.appendLine('MCP server not available in this environment', 'MCP');
				return;
			}

			this.providerRegistration = vscode.lm.registerMcpServerDefinitionProvider(
				'github-pull-requests-mcp',
				{
					onDidChangeMcpServerDefinitions: new vscode.EventEmitter<void>().event,
					provideMcpServerDefinitions: () => [
						new vscode.McpHttpServerDefinition(
							'GitHub Pull Requests',
							vscode.Uri.parse(this.serverHandle!.url),
							{ Authorization: `Bearer ${this.serverHandle!.token}` },
						),
					],
				},
			);

			const env = this.context.environmentVariableCollection;
			env.description = new vscode.MarkdownString('GitHub Pull Requests MCP server - use `$GITHUB_PR_MCP_URL` and `$GITHUB_PR_MCP_TOKEN` to connect.');
			env.persistent = false;
			env.replace('GITHUB_PR_MCP_URL', this.serverHandle.url);
			env.replace('GITHUB_PR_MCP_TOKEN', this.serverHandle.token);

			Logger.appendLine('MCP env vars set for new terminals', 'MCP');
		} catch (err) {
			Logger.appendLine(`Failed to start MCP server: ${err instanceof Error ? err.message : String(err)}`, 'MCP');
		}
	}

	private stopServer(): void {
		this.serverHandle?.dispose();
		this.serverHandle = undefined;
		this.providerRegistration?.dispose();
		this.providerRegistration = undefined;
		const env = this.context.environmentVariableCollection;
		env.delete('GITHUB_PR_MCP_URL');
		env.delete('GITHUB_PR_MCP_TOKEN');
		env.description = undefined;
	}

	private async copyConfig(): Promise<void> {
		if (!this.serverHandle) {
			const reason = !vscode.workspace.isTrusted
				? 'The MCP server is not available in untrusted workspaces.'
				: !vscode.workspace.getConfiguration().get<boolean>(SETTING_KEY, false)
					? `Enable the \`${SETTING_KEY}\` setting to start the MCP server.`
					: 'The MCP server is not available in this environment (web).';
			vscode.window.showInformationMessage(reason);
			return;
		}

		const { url, token } = this.serverHandle;
		const config = JSON.stringify({
			mcpServers: {
				'github-pull-requests': {
					type: 'http',
					url,
					headers: { Authorization: `Bearer ${token}` },
				},
			},
		}, null, 2);
		const claudeCmd = `claude mcp add --transport http github-pr "${url}" --header "Authorization: Bearer ${token}"`;
		await vscode.env.clipboard.writeText(`${config}\n\n# Claude Code:\n# ${claudeCmd}`);
		vscode.window.showInformationMessage('MCP server configuration copied to clipboard.');
	}

	override dispose(): void {
		this.stopServer();
		this.providerRegistration?.dispose();
		super.dispose();
	}
}
