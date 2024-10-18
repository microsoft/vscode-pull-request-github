/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';
import { renderPrompt } from '@vscode/prompt-tsx';
import * as vscode from 'vscode';
import { dispose } from '../common/utils';
import { ParticipantsPrompt } from './participantsPrompt';
import { IToolCall, MimeTypes } from './tools/toolsUtils';

export class ChatParticipantState {
	private _messages: vscode.LanguageModelChatMessage[] = [];

	get lastToolResult(): (string | vscode.LanguageModelToolResultPart | vscode.LanguageModelToolCallPart)[] {
		for (let i = this._messages.length - 1; i >= 0; i--) {
			const message = this._messages[i];
			for (const part of message.content2) {
				if (part instanceof vscode.LanguageModelToolResultPart) {
					return message.content2;
				}
			}
		}
		return [];
	}

	get firstUserMessage(): string | undefined {
		for (let i = 0; i < this._messages.length; i++) {
			const message = this._messages[i];
			if (message.role === vscode.LanguageModelChatMessageRole.User && message.content) {
				return message.content;
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

export class ChatParticipant implements vscode.Disposable {
	private readonly disposables: vscode.Disposable[] = [];

	constructor(context: vscode.ExtensionContext, private readonly state: ChatParticipantState) {
		const ghprChatParticipant = vscode.chat.createChatParticipant('githubpr', (
			request: vscode.ChatRequest,
			context: vscode.ChatContext,
			stream: vscode.ChatResponseStream,
			token: vscode.CancellationToken
		) => this.handleParticipantRequest(request, context, stream, token));
		ghprChatParticipant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'resources/icons/github_logo.png');
		this.disposables.push(ghprChatParticipant);
	}

	dispose() {
		dispose(this.disposables);
	}

	async handleParticipantRequest(
		request: vscode.ChatRequest,
		context: vscode.ChatContext,
		stream: vscode.ChatResponseStream,
		token: vscode.CancellationToken
	): Promise<void> {
		this.state.reset();

		const models = await vscode.lm.selectChatModels({
			vendor: 'copilot',
			family: 'gpt-4o'
		});
		const model = models[0];
		const allTools = vscode.lm.tools.map((tool): vscode.LanguageModelChatTool => {
			return {
				name: tool.name,
				description: tool.description,
				parametersSchema: tool.parametersSchema ?? {}
			};
		});

		const { messages } = await renderPrompt(
			ParticipantsPrompt,
			{ userMessage: request.prompt },
			{ modelMaxPromptTokens: model.maxInputTokens },
			model);

		this.state.addMessages(messages);

		const toolReferences = [...request.toolReferences];
		const options: vscode.LanguageModelChatRequestOptions = {
			justification: 'Answering user questions pertaining to GitHub.'
		};

		const runWithFunctions = async (): Promise<void> => {

			const requestedTool = toolReferences.shift();
			if (requestedTool) {
				options.toolChoice = requestedTool.id;
				options.tools = allTools.filter(tool => tool.name === requestedTool.id);
			} else {
				options.toolChoice = undefined;
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

					let parameters: any;
					try {
						parameters = part.parameters;
					} catch (err) {
						throw new Error(`Got invalid tool use parameters: "${JSON.stringify(part.parameters)}". (${(err as Error).message})`);
					}

					const invocationOptions = { parameters, toolInvocationToken: request.toolInvocationToken, requestedContentTypes: ['text/plain', 'text/markdown', 'text/json', 'text/display', 'command'] };
					toolCalls.push({
						call: part,
						result: vscode.lm.invokeTool(tool.name, invocationOptions, token),
						tool
					});
				}
			}

			if (toolCalls.length) {
				const assistantMsg = vscode.LanguageModelChatMessage.Assistant('');
				assistantMsg.content2 = toolCalls.map(toolCall => new vscode.LanguageModelToolCallPart(toolCall.tool.name, toolCall.call.toolCallId, toolCall.call.parameters));
				this.state.addMessage(assistantMsg);

				let hasJson = false;
				let shownToUser = false;
				for (const toolCall of toolCalls) {
					let toolCallResult = (await toolCall.result);

					const plainText = toolCallResult[MimeTypes.textPlain];
					const markdown: string = toolCallResult[MimeTypes.textMarkdown];
					const json: JSON = toolCallResult[MimeTypes.textJson];
					const display = toolCallResult[MimeTypes.textDisplay]; // our own fake type that we use to indicate something that should be streamed to the user
					const command = toolCallResult[MimeTypes.command]; // our own fake type that we use to indicate something that should be executed as a command
					if (display) {
						stream.markdown(display);
						shownToUser = true;
					}

					const content: (string | vscode.LanguageModelToolResultPart | vscode.LanguageModelToolCallPart)[] = [];
					let isOnlyPlaintext = true;
					if (json !== undefined) {
						content.push(new vscode.LanguageModelToolResultPart(toolCall.call.toolCallId, JSON.stringify(json)));
						isOnlyPlaintext = false;
						hasJson = true;
					} else if (markdown !== undefined) {
						const asMarkdownString = new vscode.MarkdownString(markdown);
						asMarkdownString.supportHtml = true;
						stream.markdown(asMarkdownString);
						shownToUser = true;
					}
					if (command) {
						stream.button(command);
					}
					if (plainText !== undefined) {
						if (isOnlyPlaintext) {
							content.push(new vscode.LanguageModelToolResultPart(toolCall.call.toolCallId, plainText));
						} else {
							content.push(plainText);
						}
					}
					const message = vscode.LanguageModelChatMessage.User('');
					message.content2 = content;
					this.state.addMessage(message);
				}

				this.state.addMessage(vscode.LanguageModelChatMessage.User(`Above is the result of calling the functions ${toolCalls.map(call => call.tool.name).join(', ')}.${hasJson ? ' The JSON is also included and should be passed to the next tool.' : ''} ${shownToUser ? 'The user can see the result of the tool call.' : ''}`));
				return runWithFunctions();
			}
		};
		await runWithFunctions();
	}

}

