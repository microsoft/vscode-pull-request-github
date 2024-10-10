/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';
import * as vscode from 'vscode';
import { dispose } from '../common/utils';
import { IToolCall } from './tools/toolsUtils';

const llmInstructions = `Instructions:
- The user will ask a question related to GitHub, and it may require lots of research to answer correctly. There is a selection of tools that let you perform actions or retrieve helpful context to answer the user's question.
- If you aren't sure which tool is relevant, you can call multiple tools. You can call tools repeatedly to take actions or gather as much context as needed until you have completed the task fully. Don't give up unless you are sure the request cannot be fulfilled with the tools you have.
- Don't ask the user for confirmation to use tools, just use them.
- When talking about issues, be as concise as possible while still conveying all the information you need to. Avoid mentioning the following:
  - The fact that there are no comments.
  - Any info that seems like template info.`;

export class ChatParticipantState {
	private _messages: vscode.LanguageModelChatMessage[] = [];

	get lastToolResult(): vscode.LanguageModelToolResultPart | undefined {
		for (let i = this._messages.length - 1; i >= 0; i--) {
			const message = this._messages[i];
			if (message.content2 && message.content2.length > 0 && message.content2[0] instanceof vscode.LanguageModelToolResultPart) {
				return message.content2[0] as vscode.LanguageModelToolResultPart;
			}
		}
	}

	get messages(): vscode.LanguageModelChatMessage[] {
		return this._messages;
	}

	addMessage(message: vscode.LanguageModelChatMessage): void {
		this._messages.push(message);
	}

	reset(): void {
		this._messages = [];
	}

	constructor() {

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
				name: tool.id,
				description: tool.description,
				parametersSchema: tool.parametersSchema ?? {}
			};
		});

		this.state.addMessage(vscode.LanguageModelChatMessage.Assistant(llmInstructions));
		this.state.addMessage(vscode.LanguageModelChatMessage.User(request.prompt));
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

					const tool = vscode.lm.tools.find(tool => tool.id === part.name);
					if (!tool) {
						throw new Error('Got invalid tool choice: ' + part.name);
					}

					let parameters: any;
					try {
						parameters = JSON.parse(part.parameters);
					} catch (err) {
						throw new Error(`Got invalid tool use parameters: "${part.parameters}". (${(err as Error).message})`);
					}

					const invocationOptions = { parameters, toolInvocationToken: request.toolInvocationToken, requestedContentTypes: ['text/plain', 'text/markdown', 'text/json'] };
					toolCalls.push({
						call: part,
						result: vscode.lm.invokeTool(tool.id, invocationOptions, token),
						tool
					});
				}
			}

			if (toolCalls.length) {
				const assistantMsg = vscode.LanguageModelChatMessage.Assistant('');
				assistantMsg.content2 = toolCalls.map(toolCall => new vscode.LanguageModelToolCallPart(toolCall.tool.id, toolCall.call.toolCallId, toolCall.call.parameters));
				this.state.addMessage(assistantMsg);

				let hasJson = false;
				for (const toolCall of toolCalls) {
					let toolCallResult = (await toolCall.result);

					const plainText = toolCallResult['text/plain'];
					const markdown = toolCallResult['text/markdown'];
					const json = toolCallResult['text/json'];
					let isOnlyPlaintext = true;
					if (json !== undefined) {
						const message = vscode.LanguageModelChatMessage.User('');

						message.content2 = [new vscode.LanguageModelToolResultPart(toolCall.call.toolCallId, JSON.stringify(json))];
						this.state.addMessage(message);
						isOnlyPlaintext = false;
						hasJson = true;

					} else if (markdown !== undefined) {
						stream.markdown(markdown);
						const message = vscode.LanguageModelChatMessage.User('');
						message.content2 = [new vscode.LanguageModelToolResultPart(toolCall.call.toolCallId, markdown)];
						this.state.addMessage(message);
						isOnlyPlaintext = false;
					}
					if ((plainText !== undefined) && isOnlyPlaintext) {
						const message = vscode.LanguageModelChatMessage.User('');
						message.content2 = [new vscode.LanguageModelToolResultPart(toolCall.call.toolCallId, plainText)];
						this.state.addMessage(message);
					}


					// Can't get the llm to pass the issues to the render tool, so we have to do it manually
					// if (toolCall.tool.id === 'github-pull-request_doSearch') {
					// 	const json: DisplayIssuesParameters = JSON.parse(toolCallResult['text/json']!) as DisplayIssuesParameters;
					// 	if (json !== undefined) {
					// 		const invocationOptions = { parameters: json, toolInvocationToken: request.toolInvocationToken, requestedContentTypes: ['text/plain', 'text/markdown', 'text/json'] };
					// 		toolCallResult = await vscode.lm.invokeTool('github-pull-request_renderIssues', invocationOptions, token);
					// 	}
					// }
				}

				this.state.addMessage(vscode.LanguageModelChatMessage.User(`Above is the result of calling the functions ${toolCalls.map(call => call.tool.id).join(', ')}.${hasJson ? ' The JSON is also included and should be passed to the next tool.' : ''}`));
				return runWithFunctions();
			}
		};
		await runWithFunctions();
	}

}

