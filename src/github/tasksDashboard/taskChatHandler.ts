/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import Logger from '../../common/logger';
import { RepositoriesManager } from '../repositoriesManager';
import { ISSUE_EXPRESSION, ParsedIssue, parseIssueExpressionOutput } from '../utils';
import { TaskDashboardWebview } from './taskDashboardWebview';
import { IssueData, TaskData, TaskManager } from './taskManager';

// Individual tool definitions
const LIST_ISSUES_TOOL = {
	name: 'listIssues',
	description: 'Lists open issues from the current repository',
} as const satisfies vscode.LanguageModelChatTool;

const LIST_TASKS_TOOL = {
	name: 'listTasks',
	description: 'Lists existing tasks (both local and remote)',
} as const satisfies vscode.LanguageModelChatTool;

const NEW_TASK_FROM_ISSUE_TOOL = {
	name: 'newTaskFromIssue',
	description: 'Creates a task from an existing issue',
	inputSchema: {
		type: 'object',
		properties: {
			issueNumber: {
				type: 'number',
				description: 'The GitHub issue number to work on'
			},
			isLocal: {
				type: 'boolean',
				description: 'Whether to work on this issue locally (true) or remotely (false)'
			}
		},
		required: ['issueNumber', 'isLocal']
	}
} as const satisfies vscode.LanguageModelChatTool;

const OPEN_EXISTING_TASK_TOOL = {
	name: 'openExistingTask',
	description: 'Opens/resumes an existing task',
	inputSchema: {
		type: 'object',
		properties: {
			taskId: {
				type: 'string',
				description: 'The unique identifier of the task to open/resume'
			}
		},
		required: ['taskId']
	}
} as const satisfies vscode.LanguageModelChatTool;

const START_TASK_TOOL = {
	name: 'startTask',
	description: 'Starts a new task with the specified work mode (local or remote)',
	inputSchema: {
		type: 'object',
		properties: {
			query: {
				type: 'string',
				description: 'The task description or query for what needs to be implemented'
			},
			isLocal: {
				type: 'boolean',
				description: 'Whether to work locally (true) or remotely using GitHub Copilot agent (false)'
			}
		},
		required: ['query']
	}
} as const satisfies vscode.LanguageModelChatTool;

const GENERAL_QUESTION_TOOL = {
	name: 'generalQuestion',
	description: 'Handles general programming questions',
	inputSchema: {
		type: 'object',
		properties: {
			query: {
				type: 'string',
				description: 'The programming question or query to ask'
			}
		},
		required: ['query']
	}
} as const satisfies vscode.LanguageModelChatTool;

/**
 * Converts a basic JSON schema to a TypeScript type.
 *
 * TODO: only supports basic schemas. Doesn't support all JSON schema features.
 */
export type SchemaToType<T> = T extends { type: 'string' }
	? string
	: T extends { type: 'number' }
	? number
	: T extends { type: 'boolean' }
	? boolean
	: T extends { type: 'null' }
	? null
	// Object
	: T extends { type: 'object'; properties: infer P }
	? { [K in keyof P]: SchemaToType<P[K]> }
	// Array
	: T extends { type: 'array'; items: infer I }
	? Array<SchemaToType<I>>
	// OneOf
	: T extends { oneOf: infer I }
	? MapSchemaToType<I>
	// Fallthrough
	: never;

type MapSchemaToType<T> = T extends [infer First, ...infer Rest]
	? SchemaToType<First> | MapSchemaToType<Rest>
	: never;


const TOOL_DEFINITIONS: vscode.LanguageModelChatTool[] = [
	LIST_ISSUES_TOOL,
	LIST_TASKS_TOOL,
	NEW_TASK_FROM_ISSUE_TOOL,
	OPEN_EXISTING_TASK_TOOL,
	START_TASK_TOOL,
	GENERAL_QUESTION_TOOL
];

export class TaskChatHandler {
	private static readonly ID = 'TaskChatHandler';

	constructor(
		private readonly _taskManager: TaskManager,
		private readonly _repositoriesManager: RepositoriesManager,
		private readonly issueQuery: string,
		private readonly _webview: TaskDashboardWebview,
	) { }

	public async handleChatSubmission(query: string): Promise<void> {
		query = query.trim();
		if (!query) {
			return;
		}

		// Use language model to determine intent and take appropriate action
		return this.handleIntentDetermination(query);
	}

	/**
	 * Uses Language Model with native tool support to determine user intent and take appropriate action
	 */
	private async handleIntentDetermination(query: string): Promise<void> {
		try {
			// Get a language model for intent determination
			const models = await vscode.lm.selectChatModels({
				vendor: 'copilot',
				family: 'gpt-5-mini'
			});

			if (!models || models.length === 0) {
				throw new Error('No language model available for intent determination');
			}

			const model = models[0];

			// Create the initial prompt for intent determination
			const systemPrompt = `You are an AI assistant that helps users work on development tasks.
Your job is to determine user wants to do based on their prompt and dispatch the appropriate final tool call.
You may use the ${LIST_ISSUES_TOOL.name}() and ${LIST_TASKS_TOOL.name}() calls to gather information before making a decision.

Important guidelines:
- IMPORTANT: If the user says @copilot, they ALWAYS want to work on a remote task. This could be an existing remote task or a new remote task.
- IMPORTANT: If the user says @local, they ALWAYS want to work on a local task. This could be an existing local task or a new local task.
- If the user mentions a specific issue number, use ${NEW_TASK_FROM_ISSUE_TOOL.name}()
- When starting new tasks, you may omit setting 'isLocal' to instead prompt the user on what type of start the want to use if this is not clear.
- Before starting work on an issue, make sure there is not already an task for it by calling ${LIST_ISSUES_TOOL.name}.
`;

			// Initialize messages and tool call loop
			let messages = [
				vscode.LanguageModelChatMessage.Assistant(systemPrompt),
				vscode.LanguageModelChatMessage.User(query)
			];

			const runWithTools = async (): Promise<void> => {
				// Send the request with tools
				const response = await model.sendRequest(messages, {
					justification: 'Determining user intent for task management',
					tools: TOOL_DEFINITIONS
				});

				// Stream text output and collect tool calls from the response
				const toolCalls: vscode.LanguageModelToolCallPart[] = [];
				let responseStr = '';

				for await (const part of response.stream) {
					if (part instanceof vscode.LanguageModelTextPart) {
						responseStr += part.value;
					} else if (part instanceof vscode.LanguageModelToolCallPart) {
						toolCalls.push(part);
					}
				}

				Logger.debug(`LM response: ${responseStr}`, TaskChatHandler.ID);

				if (toolCalls.length > 0) {
					// Handle each tool call
					let shouldContinue = false;
					for (const toolCall of toolCalls) {
						const result = await this.handleToolCall(toolCall);

						// Check if this was an informational tool that should continue the loop
						if (toolCall.name === LIST_ISSUES_TOOL.name || toolCall.name === LIST_TASKS_TOOL.name) {
							// Add the tool call and result back to the conversation
							messages.push(vscode.LanguageModelChatMessage.Assistant([new vscode.LanguageModelToolCallPart(toolCall.callId, toolCall.name, toolCall.input)]));
							if (result) {
								messages.push(vscode.LanguageModelChatMessage.User([new vscode.LanguageModelToolResultPart(toolCall.callId, [new vscode.LanguageModelTextPart(result)])]));
							}
							shouldContinue = true;
						} else {
							// This was a final action tool - stop here
							Logger.debug(`Executed final action tool: ${toolCall.name}`, TaskChatHandler.ID);
							return;
						}
					}

					// Continue the loop if we had informational tools
					if (shouldContinue) {
						return runWithTools();
					}
				}
			};

			await runWithTools();

		} catch (error) {
			Logger.error(`Failed to determine intent: ${error}`, TaskChatHandler.ID);
			throw error;
		}
	}

	/**
	 * Handles tool calls from the language model
	 */
	private async handleToolCall(toolCall: vscode.LanguageModelToolCallPart): Promise<string | void> {
		switch (toolCall.name) {
			case LIST_ISSUES_TOOL.name: {
				const issues = await this.getIssuesForLM();
				const issuesText = issues.length > 0
					? `Open Issues:\n${issues.map(i => `- Issue #${i.number}: ${i.title}`).join('\n')}`
					: 'No open issues found.';
				Logger.debug(`Found ${issues.length} issues`, TaskChatHandler.ID);
				return issuesText;
			}
			case LIST_TASKS_TOOL.name: {
				const tasks = await this.getTasksForLM();
				const tasksText = tasks.length > 0
					? `Existing Tasks:\n${tasks.map(t => `- ${t.id}: ${t.title} (${t.isLocal === true ? 'local' : 'remote'}${t.branchName ? `, branch: ${t.branchName}` : ''})`).join('\n')}`
					: 'No existing tasks found.';
				Logger.debug(`Found ${tasks.length} tasks`, TaskChatHandler.ID);
				return tasksText;
			}
			case START_TASK_TOOL.name: {
				const startParams = toolCall.input as SchemaToType<typeof START_TASK_TOOL.inputSchema>;
				if (startParams.isLocal === true) {
					await this.handleLocalTaskSubmission(startParams.query);
					Logger.debug(`Created new local task: ${startParams.query}`, TaskChatHandler.ID);
				} else if (startParams.isLocal === false) {
					await this.handleRemoteTaskSubmission(startParams.query);
					Logger.debug(`Created new remote task: ${startParams.query}`, TaskChatHandler.ID);
				} else {
					await this.handleStartTask(startParams.query);
					Logger.debug(`Created new task: ${startParams.query}`, TaskChatHandler.ID);

				}
				return;
			}
			case NEW_TASK_FROM_ISSUE_TOOL.name: {
				const issueParams = toolCall.input as SchemaToType<typeof NEW_TASK_FROM_ISSUE_TOOL.inputSchema>;
				const { issueNumber, isLocal } = issueParams;

				if (isLocal) {
					await this._taskManager.handleLocalTaskForIssue(issueNumber, { issueNumber, owner: undefined, name: undefined });
					Logger.debug(`Created local task for issue #${issueNumber}`, TaskChatHandler.ID);
				} else {
					const issueQuery = `Work on issue #${issueNumber}`;
					await this.handleRemoteTaskSubmission(issueQuery);
					Logger.debug(`Created remote task for issue #${issueNumber}`, TaskChatHandler.ID);
				}
				return;
			}
			case OPEN_EXISTING_TASK_TOOL.name: {
				const openParams = toolCall.input as SchemaToType<typeof OPEN_EXISTING_TASK_TOOL.inputSchema>;
				await this.openExistingTask(openParams.taskId);
				Logger.debug(`Opening existing task: ${openParams.taskId}`, TaskChatHandler.ID);
				return;
			}
			case GENERAL_QUESTION_TOOL.name: {
				const questionParams = toolCall.input as SchemaToType<typeof GENERAL_QUESTION_TOOL.inputSchema>;
				await this.handleGeneralQuestion(questionParams);
				Logger.debug(`Opened general question in chat: ${questionParams.query}`, TaskChatHandler.ID);
				return;
			}
			default: {
				Logger.warn(`Unknown tool call: ${toolCall.name}`, TaskChatHandler.ID);
				return;
			}
		}
	}

	private async handleGeneralQuestion(questionParams: { readonly query: string; }) {
		await vscode.commands.executeCommand('workbench.action.chat.open', {
			query: questionParams.query,
			mode: 'ask'
		});
	}

	/**
	 * Gets issues formatted for Language Model context
	 */
	private async getIssuesForLM(): Promise<IssueData[]> {
		return this._taskManager.getIssuesForQuery(this._repositoriesManager.folderManagers[0], this.issueQuery);
	}

	/**
	 * Gets tasks formatted for Language Model context
	 */
	private async getTasksForLM(): Promise<TaskData[]> {
		try {
			return await this._taskManager.getAllTasks();
		} catch (error) {
			Logger.error(`Failed to get tasks for LM: ${error}`, TaskChatHandler.ID);
			return [];
		}
	}

	/**
	 * Opens an existing task by ID
	 */
	private async openExistingTask(taskId: string): Promise<void> {
		try {
			// This is a placeholder - the actual implementation would depend on how tasks are structured
			// It might involve switching to a branch, opening a pull request, or resuming a remote session
			Logger.debug(`Opening existing task: ${taskId}`, TaskChatHandler.ID);

			const tasks = await this._taskManager.getAllTasks();
			const target = tasks.find(task => task.id === taskId);
			if (target) {
				if (target.isLocal) {
					this._webview.switchToLocalTask(target.branchName!, target.pullRequest);
				} else {
					this._webview.switchToRemoteTask(target.id, target.pullRequest);
				}
			}


			// TODO: Implement actual task opening logic based on task type
		} catch (error) {
			Logger.error(`Failed to open existing task ${taskId}: ${error}`, TaskChatHandler.ID);
		}
	}

	/**
	 * Handles starting a new task by asking user to choose between local or remote work
	 */
	private async handleStartTask(query: string): Promise<void> {
		try {
			const workMode = await this.showWorkModeQuickPick();

			if (workMode === 'local') {
				await this.handleLocalTaskSubmission(query);
			} else if (workMode === 'remote') {
				await this.handleRemoteTaskSubmission(query);
			}
			// If workMode is undefined, user cancelled - do nothing
		} catch (error) {
			Logger.error(`Failed to start task: ${error}`, TaskChatHandler.ID);
		}
	}

	private async handleLocalTaskSubmission(query: string) {
		const cleanQuery = query.replace(/@local\s*/, '').trim();
		const references = extractIssueReferences(cleanQuery);

		if (references.length > 0) {
			const firstRef = references[0];
			const issueNumber = firstRef.issueNumber;

			try {
				await this._taskManager.handleLocalTaskForIssue(issueNumber, firstRef);
			} catch (error) {
				Logger.error(`Failed to handle local task with issue support: ${error}`, TaskChatHandler.ID);
				vscode.window.showErrorMessage('Failed to set up local task branch.');
			}
		} else {
			await this._taskManager.setupNewLocalWorkflow(cleanQuery);
		}
	}

	private async handleRemoteTaskSubmission(query: string) {
		const cleanQuery = query.replace(/@copilot\s*/, '').trim();
		await this._taskManager.createRemoteBackgroundSession(cleanQuery);
	}

	/**
	 * Shows a quick pick to let user choose between local and remote work
	 */
	private async showWorkModeQuickPick(): Promise<'local' | 'remote' | undefined> {
		const quickPick = vscode.window.createQuickPick();
		quickPick.title = 'Choose how to work on this task';
		quickPick.placeholder = 'Select whether to work locally or remotely';
		quickPick.items = [
			{
				label: '$(device-desktop) Work locally',
				detail: 'Create a new branch and work in your local environment',
				alwaysShow: true
			},
			{
				label: '$(cloud) Work remotely',
				detail: 'Use GitHub Copilot remote agent to work in the cloud',
				alwaysShow: true
			}
		];

		return new Promise<'local' | 'remote' | undefined>((resolve) => {
			quickPick.onDidAccept(() => {
				const selectedItem = quickPick.selectedItems[0];
				quickPick.hide();
				if (selectedItem) {
					if (selectedItem.label.includes('locally')) {
						resolve('local');
					} else if (selectedItem.label.includes('remotely')) {
						resolve('remote');
					}
				}
				resolve(undefined);
			});

			quickPick.onDidHide(() => {
				quickPick.dispose();
				resolve(undefined);
			});

			quickPick.show();
		});
	}
}

/**
 * Extracts issue references from text (e.g., #123, owner/repo#456)
 */
function extractIssueReferences(text: string): Array<ParsedIssue> {
	const out: ParsedIssue[] = [];
	for (const match of text.matchAll(ISSUE_EXPRESSION)) {
		const parsed = parseIssueExpressionOutput(match);
		if (parsed) {
			out.push(parsed);
		}
	}
	return out;
}