/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { TitleAndDescriptionProvider } from '../api/api';
import Logger from '../common/logger';
import { ITelemetry } from '../common/telemetry';
import { CredentialStore } from '../github/credentials';

/**
 * Provides PR title and description generation using VS Code's built-in Copilot language models.
 * This provider leverages pull request templates when available to generate contextually appropriate
 * titles and descriptions that follow the repository's conventions.
 */
export class CopilotTitleAndDescriptionProvider implements TitleAndDescriptionProvider {
	private static readonly ID = 'CopilotTitleAndDescriptionProvider';

	constructor(
		private readonly credentialStore: CredentialStore,
		private readonly telemetry: ITelemetry
	) { }

	async provideTitleAndDescription(
		context: {
			commitMessages: string[];
			patches: string[] | { patch: string; fileUri: string; previousFileUri?: string }[];
			issues?: { reference: string; content: string }[];
			pullRequestTemplate?: string;
		},
		token: vscode.CancellationToken
	): Promise<{ title: string; description?: string } | undefined> {
		try {
			Logger.debug('Starting Copilot PR title and description generation', CopilotTitleAndDescriptionProvider.ID);

			// Select the appropriate language model (use user's preference from all available models)
			const models = await vscode.lm.selectChatModels();
			console.log(`Available models: ${models.map(m => `${m.vendor}:${m.family} (${m.name})`).join(', ')}`);

			if (!models || models.length === 0) {
				Logger.warn('No language models available', CopilotTitleAndDescriptionProvider.ID);
				return undefined;
			}

			// Prefer higher capability models for better PR generation
			// Priority: Claude > GPT-4 > GPT-3.5
			const model = this.selectBestModel(models);
			console.log(`Using model: ${model.vendor}:${model.family} (${model.name})`);
			Logger.debug(`Using model: ${model.vendor}:${model.family} (${model.name})`, CopilotTitleAndDescriptionProvider.ID);

			// Build the prompt
			const prompt = this.buildPrompt(context);
			const messages = [vscode.LanguageModelChatMessage.User(prompt)];

			// Send request to language model
			const response = await model.sendRequest(messages, {
				justification: 'Generating pull request title and description based on commits and repository templates'
			}, token);

			// Parse response
			let responseText = '';
			for await (const part of response.stream) {
				if (part instanceof vscode.LanguageModelTextPart) {
					responseText += part.value;
				}
			}

			const result = this.parseResponse(responseText);

			if (result) {
				Logger.debug(`Generated title: "${result.title}"`, CopilotTitleAndDescriptionProvider.ID);
				Logger.debug(`Generated description length: ${result.description?.length || 0} characters`, CopilotTitleAndDescriptionProvider.ID);

				// Track telemetry
				this.telemetry.sendTelemetryEvent('copilot.titleAndDescription.generated', {
					hasTemplate: context.pullRequestTemplate ? 'true' : 'false',
					commitCount: context.commitMessages.length.toString(),
					patchCount: Array.isArray(context.patches) ? context.patches.length.toString() : 'unknown',
					issueCount: (context.issues?.length || 0).toString(),
					modelVendor: model.vendor,
					modelFamily: model.family,
					modelName: model.name
				});
			}

			return result;
		} catch (error) {
			Logger.error(`Error generating PR title and description: ${error}`, CopilotTitleAndDescriptionProvider.ID);

			this.telemetry.sendTelemetryEvent('copilot.titleAndDescription.error', {
				error: error instanceof Error ? error.message : 'unknown'
			});

			return undefined;
		}
	}

	/**
	 * Selects the best available model for PR generation.
	 * Prioritizes models based on their capabilities for text generation.
	 */
	private selectBestModel(models: readonly vscode.LanguageModelChat[]): vscode.LanguageModelChat {
		// Define model preference order (higher priority = better for PR generation)
		const modelPreferences = [
			// Basic models (lowest priority)
			{ vendor: 'copilot', family: 'gpt-3.5-turbo', priority: 1 },
			{ vendor: 'copilot', family: 'gpt-3.5', priority: 1 },

			// Standard GPT-4 models (medium priority)
			{ vendor: 'copilot', family: 'gpt-4', priority: 2 },
			{ vendor: 'copilot', family: 'gpt-4o-mini', priority: 3 },
			{ vendor: 'copilot', family: 'gpt-4-turbo', priority: 4 },
			{ vendor: 'copilot', family: 'gpt-4o', priority: 5 },
			{ vendor: 'copilot', family: 'gpt-4.1', priority: 6 },

			// Claude models (high priority for text generation)
			{ vendor: 'copilot', family: 'claude-3-haiku', priority: 7 },
			{ vendor: 'copilot', family: 'claude-3-sonnet', priority: 8 },
			{ vendor: 'copilot', family: 'claude-3.5-sonnet', priority: 9 },
			{ vendor: 'copilot', family: 'claude-3-opus', priority: 10 },
			{ vendor: 'copilot', family: 'claude-3.7-sonnet', priority: 11 },
			{ vendor: 'copilot', family: 'claude-3.7-sonnet-thought', priority: 12 },

			// Gemini models (high priority)
			{ vendor: 'copilot', family: 'gemini-2.0-flash', priority: 13 },
			{ vendor: 'copilot', family: 'gemini-2.5-pro', priority: 14 },

			// Latest advanced models (highest priority)
			{ vendor: 'copilot', family: 'o3-mini', priority: 15 },
			{ vendor: 'copilot', family: 'claude-sonnet-4', priority: 16 },
			{ vendor: 'copilot', family: 'o4-mini', priority: 17 },
		];

		// Find the highest priority model available
		let bestModel = models[0];
		let bestPriority = 0;

		for (const model of models) {
			const preference = modelPreferences.find(
				p => p.vendor === model.vendor && p.family === model.family
			);
			const priority = preference?.priority || 0;

			if (priority > bestPriority) {
				bestModel = model;
				bestPriority = priority;
			}
		}

		Logger.debug(
			`Selected model: ${bestModel.vendor}:${bestModel.family} (priority: ${bestPriority}) from ${models.length} available models`,
			CopilotTitleAndDescriptionProvider.ID
		);

		return bestModel;
	}

	private buildPrompt(context: {
		commitMessages: string[];
		patches: string[] | { patch: string; fileUri: string; previousFileUri?: string }[];
		issues?: { reference: string; content: string }[];
		pullRequestTemplate?: string;
	}): string {
		let prompt = `You are an expert at writing clear, concise pull request titles and descriptions. Please generate a suitable title and description for this pull request based on the provided information.

**Requirements:**
1. Title should be concise (under 50 characters when possible) and descriptive
2. Title should follow conventional commit format when appropriate (e.g., "feat:", "fix:", "docs:", etc.)
3. Description should be comprehensive but focused
4. If a pull request template is provided, follow its structure and fill in the sections appropriately
5. Reference any related issues mentioned in commits
6. Summarize the key changes without being overly technical

`;

		// Add commit information
		if (context.commitMessages && context.commitMessages.length > 0) {
			prompt += `**Commit Messages:**\n`;
			context.commitMessages.forEach((msg, index) => {
				prompt += `${index + 1}. ${msg}\n`;
			});
			prompt += '\n';
		}

		// Add patch information summary
		if (context.patches && context.patches.length > 0) {
			prompt += `**Changes Summary:**\n`;
			if (Array.isArray(context.patches) && typeof context.patches[0] === 'string') {
				prompt += `${context.patches.length} file(s) modified\n`;
			} else {
				const patchObjects = context.patches as { patch: string; fileUri: string; previousFileUri?: string }[];
				prompt += `Files modified: ${patchObjects.length}\n`;
				const fileList = patchObjects.map(p => p.fileUri).slice(0, 10); // Limit to first 10 files
				prompt += `Key files: ${fileList.join(', ')}${patchObjects.length > 10 ? '...' : ''}\n`;
			}
			prompt += '\n';
		}

		// Add related issues
		if (context.issues && context.issues.length > 0) {
			prompt += `**Related Issues:**\n`;
			context.issues.forEach(issue => {
				prompt += `- ${issue.reference}: ${issue.content}\n`;
			});
			prompt += '\n';
		}

		// Add pull request template - this is the key part for template integration
		if (context.pullRequestTemplate) {
			prompt += `**Pull Request Template to Follow:**\n`;
			prompt += '```\n' + context.pullRequestTemplate + '\n```\n\n';
			prompt += `Please structure the description according to this template. Fill in each section with relevant information based on the commits and changes. If a section is not applicable, you may omit it or note "N/A".\n\n`;
		}

		prompt += `**Output Format:**
Please respond with the title and description in the following format:

TITLE: [Your generated title here]

DESCRIPTION:
[Your generated description here]

Make sure the title is on a single line after "TITLE:" and the description follows after "DESCRIPTION:" on subsequent lines.`;

		return prompt;
	}

	private parseResponse(responseText: string): { title: string; description?: string } | undefined {
		try {
			// Look for TITLE: and DESCRIPTION: markers
			const titleMatch = responseText.match(/TITLE:\s*(.+?)(?=\n|$)/i);
			const descriptionMatch = responseText.match(/DESCRIPTION:\s*([\s\S]*?)(?=\n\n|$)/i);

			if (!titleMatch) {
				Logger.warn('Could not parse title from response', CopilotTitleAndDescriptionProvider.ID);
				return undefined;
			}

			const title = titleMatch[1].trim();
			const description = descriptionMatch ? descriptionMatch[1].trim() : undefined;

			// Validate title
			if (!title || title.length === 0) {
				Logger.warn('Generated title is empty', CopilotTitleAndDescriptionProvider.ID);
				return undefined;
			}

			// Clean up description
			const cleanDescription = description && description.length > 0
				? description.replace(/^[\s\n]+|[\s\n]+$/g, '') // Trim whitespace and newlines
				: undefined;

			return {
				title,
				description: cleanDescription
			};
		} catch (error) {
			Logger.error(`Error parsing response: ${error}`, CopilotTitleAndDescriptionProvider.ID);
			return undefined;
		}
	}
}
