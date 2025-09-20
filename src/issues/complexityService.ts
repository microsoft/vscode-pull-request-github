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
	codeContext?: string;
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
				Logger.debug(
					'No language model available for complexity calculation',
					ComplexityService.ID,
				);
				return { score: 50 }; // Default to medium complexity
			}

			const model = models[0];

			// Get code context using CodeSearch API
			const codeContext = await this.getCodeContext(issue);

			const prompt = this.createComplexityPrompt(issue, codeContext);

			const messages = [vscode.LanguageModelChatMessage.User(prompt)];

			const request = await model.sendRequest(messages, {
				justification:
					'Calculating issue complexity to help prioritize developer work',
			});

			let response = '';
			for await (const fragment of request.text) {
				response += fragment;
			}

			const complexityScore = this.parseComplexityResponse(response);

			// Add code context to the result if available
			if (codeContext) {
				complexityScore.codeContext = codeContext;
			}

			// Cache the result
			this._cache.set(cacheKey, complexityScore);

			return complexityScore;
		} catch (error) {
			Logger.error(
				`Failed to calculate complexity for issue #${issue.number}: ${error}`,
				ComplexityService.ID,
			);
			return { score: 50 }; // Default to medium complexity on error
		}
	}

	/**
	 * Get relevant code context using VS Code CodeSearch API
	 */
	private async getCodeContext(issue: IssueModel): Promise<string | undefined> {
		try {
			const codeSearchTool = vscode.lm.tools.find((value) =>
				value.tags.includes('vscode_codesearch'),
			);
			if (!codeSearchTool) {
				Logger.debug('CodeSearch tool not available', ComplexityService.ID);
				return undefined;
			}

			// Create search queries from issue title and description
			const searchQueries = this.extractSearchQueries(issue);

			let codeContext = '';
			for (const query of searchQueries) {
				try {
					const codeSearchResult = await vscode.lm.invokeTool(
						codeSearchTool.name,
						{
							toolInvocationToken: undefined,
							input: { query },
						},
					);

					const plainTextResult = codeSearchResult.content[0];
					if (plainTextResult instanceof vscode.LanguageModelTextPart) {
						codeContext += `\n--- Search results for "${query}" ---\n${plainTextResult.value}\n`;
					}
				} catch (searchError) {
					Logger.debug(
						`Failed to search for "${query}": ${searchError}`,
						ComplexityService.ID,
					);
				}
			}

			return codeContext.trim() || undefined;
		} catch (error) {
			Logger.debug(
				`Failed to get code context: ${error}`,
				ComplexityService.ID,
			);
			return undefined;
		}
	}

	/**
	 * Extract relevant search queries from issue title and description
	 */
	private extractSearchQueries(issue: IssueModel): string[] {
		const queries: string[] = [];

		// Use the issue title as the primary search query
		if (issue.title) {
			queries.push(issue.title);
		}

		// Extract function names, class names, and file references from the issue body
		if (issue.body) {
			const body = issue.body;

			// Look for code references (functions, methods, classes)
			const codeReferencePatterns = [
				/\b([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g, // function calls like "myFunction("
				/class\s+([a-zA-Z_][a-zA-Z0-9_]*)/g, // class definitions
				/([a-zA-Z_][a-zA-Z0-9_]*)\.(ts|js|tsx|jsx|py|java|cs|cpp|h)$/gm, // file references
				/`([a-zA-Z_][a-zA-Z0-9_\.]*)`/g, // backtick-quoted identifiers
			];

			for (const pattern of codeReferencePatterns) {
				let match;
				while ((match = pattern.exec(body)) !== null) {
					const extracted = match[1] || match[0];
					if (extracted && extracted.length > 2 && extracted.length < 50) {
						queries.push(extracted);
					}
				}
			}
		}

		// Limit to top 3 most relevant queries to avoid overwhelming the search
		return [...new Set(queries)].slice(0, 3);
	}

	/**
	 * Create a prompt for the language model to analyze issue complexity
	 */
	private createComplexityPrompt(
		issue: IssueModel,
		codeContext?: string,
	): string {
		const labels =
			issue.item.labels?.map((label) => label.name).join(', ') || 'None';
		const assignees = issue.assignees?.map((a) => a.login).join(', ') || 'None';

		let prompt = `Analyze the complexity of this GitHub issue and provide a score from 1-100 where:
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
Milestone: ${issue.milestone?.title || 'None'}`;

		// Add code context if available
		if (codeContext) {
			prompt += `

Code Context from Repository:
${codeContext}

Consider the above code context when assessing complexity. Look for:
- How many files/components would need to be modified
- The complexity of existing code that would be affected
- Dependencies between components
- Testing requirements based on the code structure`;
		}

		prompt += `

Please respond with ONLY a JSON object in this format:
{
	"score": <number between 1-100>,
	"reasoning": "<brief explanation of why this score was chosen, including any relevant code context>"
}`;

		return prompt;
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
				if (
					typeof parsed.score === 'number' &&
					parsed.score >= 1 &&
					parsed.score <= 100
				) {
					return {
						score: Math.round(parsed.score),
						reasoning: parsed.reasoning || undefined,
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

			Logger.debug(
				`Could not parse complexity response: ${response}`,
				ComplexityService.ID,
			);
			return { score: 50 };
		} catch (error) {
			Logger.error(
				`Error parsing complexity response: ${error}`,
				ComplexityService.ID,
			);
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
