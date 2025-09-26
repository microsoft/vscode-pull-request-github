/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import Logger from '../../common/logger';
import { IssueReference, TaskManager } from './taskManager';

export class TaskChatHandler {
	private static readonly ID = 'TaskChatHandler';

	constructor(
		private readonly _taskManager: TaskManager,
	) { }

	public async handleChatSubmission(query: string): Promise<void> {
		query = query.trim();
		if (!query) {
			return;
		}

		// Check if user explicitly mentions @copilot for remote background session
		if (query.startsWith('@copilot ')) {
			return this.handleRemoteTaskSubmission(query);
		}
		// Check if user explicitly mentions @local for local workflow
		else if (query.startsWith('@local ')) {
			return this.handleLocalTaskSubmission(query);
		}
		// Determine if this is a general question or coding task
		else {
			if (await this.isCodingTask(query)) {
				// Show quick pick to choose between local and remote work
				const workMode = await this.showWorkModeQuickPick();
				if (workMode === 'remote') {
					return this.handleRemoteTaskSubmission(query);
				} else if (workMode === 'local') {
					return this.handleLocalTaskSubmission(query);
				} else {
					// User cancelled the quick pick
					return;
				}
			} else {
				// General question - Submit to ask mode
				await vscode.commands.executeCommand('workbench.action.chat.open', {
					query,
					mode: 'ask'
				});
			}
		}
	}

	private async handleLocalTaskSubmission(query: string) {
		const cleanQuery = query.replace(/@local\s*/, '').trim();
		await this.handleLocalTaskWithIssueSupport(cleanQuery || query);
	}

	private async handleRemoteTaskSubmission(query: string) {
		const cleanQuery = query.replace(/@copilot\s*/, '').trim();
		await this.createRemoteBackgroundSession(cleanQuery);
	}

	private async setupLocalWorkflow(query: string): Promise<void> {
		await this._taskManager.setupNewLocalWorkflow(query);
	}

	private async createRemoteBackgroundSession(query: string): Promise<void> {
		await this._taskManager.createRemoteBackgroundSession(query);
	}

	/**
	 * Handles local task submission with issue support - creates branches and formats prompts
	 */
	private async handleLocalTaskWithIssueSupport(query: string): Promise<void> {
		const references = extractIssueReferences(query);

		if (references.length > 0) {
			const firstRef = references[0];
			const issueNumber = firstRef.number;

			try {
				await this._taskManager.handleLocalTaskForIssue(issueNumber, firstRef);
			} catch (error) {
				Logger.error(`Failed to handle local task with issue support: ${error}`, TaskChatHandler.ID);
				vscode.window.showErrorMessage('Failed to set up local task branch.');
			}
		} else {
			await this.setupLocalWorkflow(query);
		}
	}

	/**
	 * Determines if a query represents a coding task vs a general question using VS Code's Language Model API
	 */
	private async isCodingTask(query: string): Promise<boolean> {
		try {
			// Try to get a language model for classification
			const models = await vscode.lm.selectChatModels({
				vendor: 'copilot',
				family: 'gpt-4o'
			});

			if (!models || models.length === 0) {
				return false;
			}

			const model = models[0];

			// Create a focused prompt for binary classification
			const classificationPrompt = `You are a classifier that determines whether a user query represents a coding/development task or a general question.

Examples of CODING TASKS:
- "Implement user authentication"
- "Fix the bug in the login function"
- "Add a search feature to the app"
- "Refactor the database connection code"
- "Create unit tests for the API"
- "Debug the memory leak issue"
- "Update the CSS styling"
- "Build a REST endpoint"

Examples of GENERAL QUESTIONS:
- "How does authentication work?"
- "What is a REST API?"
- "Explain the difference between async and sync"
- "What are the benefits of unit testing?"
- "How do I learn React?"
- "What is the best IDE for Python?"

Respond with exactly one word: "CODING" if the query is about implementing, building, fixing, creating, or working on code. "GENERAL" if it's asking for information, explanations, or learning resources.

Query: "${query}"

Classification:`;

			const messages = [vscode.LanguageModelChatMessage.User(classificationPrompt)];

			const response = await model.sendRequest(messages, {
				justification: 'Classifying user query type for workflow routing'
			});

			let result = '';
			for await (const chunk of response.text) {
				result += chunk;
			}

			// Parse the response - look for "CODING" or "GENERAL"
			const cleanResult = result.trim().toUpperCase();
			return cleanResult.includes('CODING');

		} catch (error) {
			return true;
		}
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
function extractIssueReferences(text: string): Array<IssueReference> {
	const out: IssueReference[] = [];

	// Match full repository issue references (owner/repo#123)
	const fullRepoRegex = /([a-zA-Z0-9._-]+)\/([a-zA-Z0-9._-]+)#(\d+)/g;
	let match: RegExpExecArray | null;
	while ((match = fullRepoRegex.exec(text)) !== null) {
		out.push({
			number: parseInt(match[3], 10),
			repo: {
				owner: match[1],
				name: match[2],
			},
		});
	}

	// Match simple issue references (#123) for current repo
	const simpleRegex = /#(\d+)(?![a-zA-Z0-9._-])/g;
	while ((match = simpleRegex.exec(text)) !== null) {
		out.push({
			number: parseInt(match[1], 10),
		});
	}

	return out;
}