/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import Logger from '../common/logger';
import { IssueModel } from '../github/issueModel';

export interface ComplexityScore {
	score: number;
	reasoning?: string;
}

export class ComplexityService {
	private static readonly ID = 'ComplexityService';
	private _cache = new Map<string, ComplexityScore>();

	/**
	 * Calculate complexity score for an issue using VS Code's LM API
	 * @param issue The issue to calculate complexity for
	 * @returns A complexity score from 1-100 (1 = simple, 100 = very complex)
	 */
	async calculateComplexity(issue: IssueModel): Promise<ComplexityScore> {
		const cacheKey = `${issue.number}-${issue.updatedAt}`;

		// Check cache first
		if (this._cache.has(cacheKey)) {
			return this._cache.get(cacheKey)!;
		}

		try {
			const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
			if (models.length === 0) {
				Logger.debug('No language model available for complexity calculation', ComplexityService.ID);
				return { score: 50 }; // Default to medium complexity
			}

			const model = models[0];
			const prompt = this.createComplexityPrompt(issue);

			const messages = [
				vscode.LanguageModelChatMessage.User(prompt)
			];

			const request = await model.sendRequest(messages, {
				justification: 'Calculating issue complexity to help prioritize developer work'
			});

			let response = '';
			for await (const fragment of request.text) {
				response += fragment;
			}

			const complexityScore = this.parseComplexityResponse(response);

			// Cache the result
			this._cache.set(cacheKey, complexityScore);

			return complexityScore;
		} catch (error) {
			Logger.error(`Failed to calculate complexity for issue #${issue.number}: ${error}`, ComplexityService.ID);
			return { score: 50 }; // Default to medium complexity on error
		}
	}

	/**
	 * Create a prompt for the language model to analyze issue complexity
	 */
	private createComplexityPrompt(issue: IssueModel): string {
		const labels = issue.item.labels?.map(label => label.name).join(', ') || 'None';
		const assignees = issue.assignees?.map(a => a.login).join(', ') || 'None';

		return `Analyze the complexity of this GitHub issue and provide a score from 1-100 where:
- 1-20: Very simple (typo fixes, minor documentation updates)
- 21-40: Simple (small feature additions, simple bug fixes)
- 41-60: Medium (moderate features, complex bug fixes)
- 61-80: Complex (large features, architectural changes)
- 81-100: Very complex (major system overhauls, complex integrations)

Issue Details:
Title: ${issue.title}
Description: ${issue.body || 'No description provided'}
Labels: ${labels}
Assignees: ${assignees}
State: ${issue.state}
Milestone: ${issue.milestone?.title || 'None'}

Please respond with ONLY a JSON object in this format:
{
	"score": <number between 1-100>,
	"reasoning": "<brief explanation of why this score was chosen>"
}`;
	}

	/**
	 * Parse the language model response to extract complexity score
	 */
	private parseComplexityResponse(response: string): ComplexityScore {
		try {
			// Try to extract JSON from the response
			const jsonMatch = response.match(/\{[\s\S]*\}/);
			if (jsonMatch) {
				const parsed = JSON.parse(jsonMatch[0]);
				if (typeof parsed.score === 'number' && parsed.score >= 1 && parsed.score <= 100) {
					return {
						score: Math.round(parsed.score),
						reasoning: parsed.reasoning || undefined
					};
				}
			}

			// Fallback: look for just a number in the response
			const numberMatch = response.match(/\b(\d{1,3})\b/);
			if (numberMatch) {
				const score = parseInt(numberMatch[1], 10);
				if (score >= 1 && score <= 100) {
					return { score };
				}
			}

			Logger.debug(`Could not parse complexity response: ${response}`, ComplexityService.ID);
			return { score: 50 };
		} catch (error) {
			Logger.error(`Error parsing complexity response: ${error}`, ComplexityService.ID);
			return { score: 50 };
		}
	}

	/**
	 * Clear the cache (useful for testing or when issues are updated)
	 */
	clearCache(): void {
		this._cache.clear();
	}

	/**
	 * Get cached complexity score if available
	 */
	getCachedComplexity(issue: IssueModel): ComplexityScore | undefined {
		const cacheKey = `${issue.number}-${issue.updatedAt}`;
		return this._cache.get(cacheKey);
	}
}
