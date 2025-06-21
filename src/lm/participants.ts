/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';
import { renderPrompt } from '@vscode/prompt-tsx';
import * as vscode from 'vscode';
import { Disposable } from '../common/lifecycle';
import { CodingAgentPrompt, ParticipantsPrompt } from './participantsPrompt';
import { IToolCall, TOOL_COMMAND_RESULT, TOOL_MARKDOWN_RESULT } from './tools/toolsUtils';

export class ChatParticipantState {
	private _messages: vscode.LanguageModelChatMessage[] = [];

	get lastToolResult(): (vscode.LanguageModelTextPart | vscode.LanguageModelToolResultPart | vscode.LanguageModelToolCallPart)[] {
		for (let i = this._messages.length - 1; i >= 0; i--) {
			const message = this._messages[i];
			for (const part of message.content) {
				if (part instanceof vscode.LanguageModelToolResultPart) {
					return message.content;
				}
			}
		}
		return [];
	}

	get firstUserMessage(): vscode.LanguageModelTextPart | undefined {
		for (let i = 0; i < this._messages.length; i++) {
			const message = this._messages[i];
			if (message.role === vscode.LanguageModelChatMessageRole.User && message.content) {
				for (const part of message.content) {
					if (part instanceof vscode.LanguageModelTextPart) {
						return part;
					}
				}
			}
		}
	}

	get messages(): vscode.LanguageModelChatMessage[] {
		return this._messages;
	}

	addMessage(message: vscode.LanguageModelChatMessage): void {
		this._messages.push(message);
	}

	addMessages(messages: vscode.LanguageModelChatMessage[]): void {
		this._messages.push(...messages);
	}

	reset(): void {
		this._messages = [];
	}
}

export class ChatParticipant extends Disposable {

	constructor(context: vscode.ExtensionContext, private readonly state: ChatParticipantState) {
		super();
		const ghprChatParticipant = this._register(vscode.chat.createChatParticipant('githubpr', (
			request: vscode.ChatRequest,
			context: vscode.ChatContext,
			stream: vscode.ChatResponseStream,
			token: vscode.CancellationToken
		) => this.handleParticipantRequest(request, context, stream, token)));
		ghprChatParticipant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'resources/icons/github_logo.png');
	}

	async handleParticipantRequest(
		request: vscode.ChatRequest,
		context: vscode.ChatContext,
		stream: vscode.ChatResponseStream,
		token: vscode.CancellationToken
	): Promise<void> {
		this.state.reset();

		const useCodingAgent = request.command && request.command === 'codingAgent';
		const models = await vscode.lm.selectChatModels({
			vendor: 'copilot',
			family: 'gpt-4o'
		});
		const model = models[0];

		const allTools = (useCodingAgent
			? vscode.lm.tools
				.filter(tool => tool.name === 'github-pull-request_copilot-coding-agent')
			: vscode.lm.tools).map((tool): vscode.LanguageModelChatTool => {
				return {
					name: tool.name,
					description: tool.description,
					inputSchema: tool.inputSchema ?? {}
				};
			});

		const { messages } = await renderPrompt(
			useCodingAgent ? CodingAgentPrompt : ParticipantsPrompt,
			{ userMessage: request.prompt },
			{ modelMaxPromptTokens: model.maxInputTokens },
			model);

		this.state.addMessages(messages);

		const toolReferences = [...request.toolReferences];
		const options: vscode.LanguageModelChatRequestOptions = {
			justification: 'Answering user questions pertaining to GitHub.'
		};

		const commands: vscode.Command[] = [];
		const runWithFunctions = async (): Promise<void> => {

			const requestedTool = toolReferences.shift();
			if (requestedTool) {
				options.toolMode = vscode.LanguageModelChatToolMode.Required;
				options.tools = allTools.filter(tool => tool.name === requestedTool.name);
			} else {
				options.toolMode = undefined;
				options.tools = allTools;
			}

			const toolCalls: IToolCall[] = [];
			const response = await model.sendRequest(this.state.messages, options, token);

			for await (const part of response.stream) {

				if (part instanceof vscode.LanguageModelTextPart) {
					stream.markdown(part.value);
				} else if (part instanceof vscode.LanguageModelToolCallPart) {

					const tool = vscode.lm.tools.find(tool => tool.name === part.name);
					if (!tool) {
						throw new Error('Got invalid tool choice: ' + part.name);
					}

					let input: any;
					try {
						input = part.input;
					} catch (err) {
						throw new Error(`Got invalid tool use parameters: "${JSON.stringify(part.input)}". (${(err as Error).message})`);
					}

					const invocationOptions: vscode.LanguageModelToolInvocationOptions<any> = { input, toolInvocationToken: request.toolInvocationToken };
					toolCalls.push({
						call: part,
						result: vscode.lm.invokeTool(tool.name, invocationOptions, token),
						tool
					});
				}
			}

			if (toolCalls.length) {
				const assistantMsg = vscode.LanguageModelChatMessage.Assistant('');
				assistantMsg.content = toolCalls.map(toolCall => new vscode.LanguageModelToolCallPart(toolCall.call.callId, toolCall.tool.name, toolCall.call.input));
				this.state.addMessage(assistantMsg);

				let shownToUser = false;
				for (const toolCall of toolCalls) {
					let toolCallResult = (await toolCall.result);

					const additionalContent: vscode.LanguageModelTextPart[] = [];
					let result: vscode.LanguageModelToolResultPart | undefined;

					for (let i = 0; i < toolCallResult.content.length; i++) {
						const part = toolCallResult.content[i];
						if (!(part instanceof vscode.LanguageModelTextPart)) {
							// We only support text results for now, will change when we finish adopting prompt-tsx
							result = new vscode.LanguageModelToolResultPart(toolCall.call.callId, toolCallResult.content);
							continue;
						}

						if (part.value === TOOL_MARKDOWN_RESULT) {
							const markdown = new vscode.MarkdownString((toolCallResult.content[++i] as vscode.LanguageModelTextPart).value);
							markdown.supportHtml = true;
							stream.markdown(markdown);
							shownToUser = true;
						} else if (part.value === TOOL_COMMAND_RESULT) {
							commands.push(JSON.parse((toolCallResult.content[++i] as vscode.LanguageModelTextPart).value) as vscode.Command);
						} else {
							if (!result) {
								result = new vscode.LanguageModelToolResultPart(toolCall.call.callId, [part]);
							} else {
								additionalContent.push(part);
							}
						}
					}
					const message = vscode.LanguageModelChatMessage.User('');
					message.content = [result!];
					this.state.addMessage(message);
					if (additionalContent.length) {
						const additionalMessage = vscode.LanguageModelChatMessage.User('');
						additionalMessage.content = additionalContent;
						this.state.addMessage(additionalMessage);
					}
				}

				this.state.addMessage(vscode.LanguageModelChatMessage.User(`Above is the result of calling the functions ${toolCalls.map(call => call.tool.name).join(', ')}. ${shownToUser ? 'The user can see the result of the tool call.' : ''}`));
				return runWithFunctions();
			}
		};
		await runWithFunctions();
		this.addButtons(stream, commands);
	}

	private addButtons(stream: vscode.ChatResponseStream, commands: vscode.Command[]) {
		for (const command of commands) {
			stream.button(command);
		}
	}
}

