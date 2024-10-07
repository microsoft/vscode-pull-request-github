/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';
import * as vscode from 'vscode';

interface IToolCall {
	tool: vscode.LanguageModelToolDescription;
	call: vscode.LanguageModelChatResponseToolCallPart;
	result: Thenable<vscode.LanguageModelToolResult>;
}

const llmInstructions = `Instructions:
- The user will send a request about a GitHub Issue. Use the 'github-pull-request_issue' tool to answer the request.
- If no specific request is made, summarize the linked issue.`;

export async function handleIssueCommand(
	request: vscode.ChatRequest,
	context: vscode.ChatContext,
	stream: vscode.ChatResponseStream,
	token: vscode.CancellationToken
): Promise<void> {

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

	const messages = [vscode.LanguageModelChatMessage.User(llmInstructions)];
	messages.push(vscode.LanguageModelChatMessage.User(request.prompt));
	const toolReferences = [...request.toolReferences];

	const options: vscode.LanguageModelChatRequestOptions = {
		justification: 'GPT-4o will be used to summarize the issue.',
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

		const response = await model.sendRequest(messages, options, token);

		for await (const part of response.stream) {

			if (part instanceof vscode.LanguageModelChatResponseTextPart) {
				stream.markdown(part.value);
			} else if (part instanceof vscode.LanguageModelChatResponseToolCallPart) {

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

				const invokationOptions = { parameters, toolInvocationToken: request.toolInvocationToken, requestedContentTypes: ['text/plain'] };
				toolCalls.push({
					call: part,
					result: vscode.lm.invokeTool(tool.id, invokationOptions, token),
					tool
				});
			}
		}

		if (toolCalls.length) {

			// Not sure what the below is needed for?
			const assistantMsg = vscode.LanguageModelChatMessage.Assistant('');
			assistantMsg.content2 = toolCalls.map(toolCall => new vscode.LanguageModelChatResponseToolCallPart(toolCall.tool.id, toolCall.call.toolCallId, toolCall.call.parameters));
			messages.push(assistantMsg);
			// Not sure what the above is needed for?

			for (const toolCall of toolCalls) {
				const message = vscode.LanguageModelChatMessage.User('');
				const toolCallResult = (await toolCall.result)['text/plain'];
				if (toolCallResult !== undefined) {
					message.content2 = [new vscode.LanguageModelChatMessageToolResultPart(toolCall.call.toolCallId, (await toolCall.result)['text/plain']!)];
					messages.push(message);
				}
			}

			messages.push(vscode.LanguageModelChatMessage.User(`Above is the result of calling the functions ${toolCalls.map(call => call.tool.id).join(', ')}. The user cannot see this result, so you should explain it to the user if referencing it in your answer.`));
			return runWithFunctions();
		}
	};
	await runWithFunctions();
}