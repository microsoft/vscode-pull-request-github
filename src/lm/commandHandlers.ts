/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';
import * as vscode from 'vscode';

interface IToolCall {
	tool: vscode.LanguageModelToolDescription;
	call: vscode.LanguageModelToolCallPart;
	result: Thenable<vscode.LanguageModelToolResult>;
}

const llmInstructions = `Instructions:
- The user will ask a question related to GitHub, and it may require lots of research to answer correctly. There is a selection of tools that let you perform actions or retrieve helpful context to answer the user's question.
- If you aren't sure which tool is relevant, you can call multiple tools. You can call tools repeatedly to take actions or gather as much context as needed until you have completed the task fully. Don't give up unless you are sure the request cannot be fulfilled with the tools you have.
- Don't ask the user for confirmation to use tools, just use them.
- When talking about issues:
  - Be as concise as possible while still conveying all the information you need to. Avoid mentioning the following:
    - The fact that there are no comments.
    - Any info that seems like template info.
  - When asked to fix an issue, search the code-base for relevant information and suggest pointers for a fix or propose a solution.`;

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

	const messages = [vscode.LanguageModelChatMessage.Assistant(llmInstructions)];
	messages.push(vscode.LanguageModelChatMessage.User(request.prompt));
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
		const response = await model.sendRequest(messages, options, token);

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
			messages.push(assistantMsg);

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
					messages.push(message);
					isOnlyPlaintext = false;
					hasJson = true;

				} else if (markdown !== undefined) {
					stream.markdown(markdown);
					const message = vscode.LanguageModelChatMessage.User('');
					message.content2 = [new vscode.LanguageModelToolResultPart(toolCall.call.toolCallId, markdown)];
					messages.push(message);
					isOnlyPlaintext = false;
				}
				if ((plainText !== undefined) && isOnlyPlaintext) {
					const message = vscode.LanguageModelChatMessage.User('');
					message.content2 = [new vscode.LanguageModelToolResultPart(toolCall.call.toolCallId, plainText)];
					messages.push(message);
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

			messages.push(vscode.LanguageModelChatMessage.User(`Above is the result of calling the functions ${toolCalls.map(call => call.tool.id).join(', ')}.${hasJson ? ' The JSON is also included and should be passed to the next tool.' : ''}`));
			return runWithFunctions();
		}
	};
	await runWithFunctions();
}