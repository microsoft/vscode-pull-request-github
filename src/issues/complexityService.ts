/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IssueModel } from '../github/issueModel';

export interface ComplexityScore {
	score: number;
	reasoning?: string;
	codeContext?: string;
	codeSearchUsed?: boolean;
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
		console.log(`🚀 COMPLEXITY SERVICE EXECUTING FOR ISSUE #${issue.number} - NEW VERSION WITH DEBUG`);

		const cacheKey = `${issue.number}-${issue.updatedAt}`;

		// Check cache first
		if (this._cache.has(cacheKey)) {
			console.log(`✅ Using cached complexity for issue #${issue.number}`);
			return this._cache.get(cacheKey)!;
		}

		console.log(`Calculating complexity for issue #${issue.number}: ${issue.title}`);

		// Retry logic for LM API access
		console.log(`DEBUG: Starting retry loop for issue #${issue.number}`);
		for (let attempt = 1; attempt <= 3; attempt++) {
			try {
				console.log(`DEBUG: Attempt ${attempt} starting for issue #${issue.number}`);
				console.log(`Attempt ${attempt} for issue #${issue.number}`);
				const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
				console.log(`Found ${models.length} language models available (attempt ${attempt})`);

				if (models.length === 0) {
					if (attempt < 3) {
						console.log(`No models found, waiting 1 second before retry...`);
						await new Promise(resolve => setTimeout(resolve, 1000));
						continue;
					} else {
						console.log('No language model available for complexity calculation after 3 attempts');
						return { score: -1 }; // Error indicator
					}
				}

				const model = models[0];
				console.log(`Using model: ${model.name} (${model.vendor}/${model.family})`);

				// Get code context using CodeSearch API
				console.log(`DEBUG: About to call getCodeContext for issue #${issue.number}`);
				let codeContext: string | undefined;
				try {
					codeContext = await this.getCodeContext(issue);
					console.log(`DEBUG: getCodeContext completed. Code context length: ${codeContext?.length || 0} characters`);
				} catch (codeSearchError) {
					console.log(`DEBUG: getCodeContext failed, proceeding without code context: ${codeSearchError}`);
					codeContext = undefined;
				}

				const prompt = this.createComplexityPrompt(issue, codeContext);
				console.log(`Prompt length: ${prompt.length} characters`);

				const messages = [vscode.LanguageModelChatMessage.User(prompt)];

				const request = await model.sendRequest(messages, {
					justification:
						'Calculating issue complexity to help prioritize developer work',
				});

				let response = '';
				for await (const fragment of request.text) {
					response += fragment;
				}

				console.log(`LM response: ${response}`);

				const complexityScore = this.parseComplexityResponse(response);
				console.log(`Parsed complexity score: ${complexityScore.score}, reasoning: ${complexityScore.reasoning}`);

			// Add code context to the result if available
			if (codeContext) {
				complexityScore.codeContext = codeContext;
				complexityScore.codeSearchUsed = true;
				console.log(`CodeSearch was used for issue #${issue.number} - ASTERISK SHOULD SHOW`);
			} else {
				complexityScore.codeSearchUsed = false;
				console.log(`CodeSearch was NOT used for issue #${issue.number} - no asterisk`);
			}				// Cache the result
				this._cache.set(cacheKey, complexityScore);

				return complexityScore;
			} catch (error) {
				console.log(`DEBUG: Attempt ${attempt} failed for issue #${issue.number}: ${error}`);
				console.log(`DEBUG: Error type: ${error?.constructor?.name}`);
				console.log(`DEBUG: Error stack: ${error?.stack}`);
				if (attempt < 3) {
					console.log(`Waiting 1 second before retry...`);
					await new Promise(resolve => setTimeout(resolve, 1000));
				} else {
					console.log(`DEBUG: Failed to calculate complexity for issue #${issue.number} after 3 attempts: ${error}`);
					console.log(`DEBUG: Final error type: ${error?.constructor?.name}`);
					console.log(`DEBUG: Final error stack: ${error?.stack}`);
					return { score: -1 }; // Error indicator
				}
			}
		}

		return { score: -1 }; // Fallback
	}

	/**
	 * Get relevant code context using GitHub API search
	 */
	private async getCodeContext(issue: IssueModel): Promise<string | undefined> {
		try {
			console.log(`DEBUG: getCodeContext called for issue #${issue.number}`);
			console.log(`Getting code context for issue #${issue.number} using GitHub API`);

			// Use LM to generate intelligent search queries
			console.log(`DEBUG: About to call generateSearchQueries`);
			const searchQueries = await this.generateSearchQueries(issue);
			console.log(`DEBUG: generateSearchQueries completed`);
			console.log(`LM-generated search queries: ${searchQueries.join(', ')}`);

			if (searchQueries.length === 0) {
				console.log('DEBUG: No search queries generated from issue, returning undefined');
				return undefined;
			}

			// Get GitHub repository info from the issue
			const repoOwner = issue.remote.owner;
			const repoName = issue.remote.repositoryName;
			console.log(`Searching in repo: ${repoOwner}/${repoName}`);

			let codeContext = '';
			for (const query of searchQueries) {
				try {
					console.log(`GitHub API search for: "${query}"`);

					// Use the GitHub repository's octokit instance to search
					const { octokit } = await issue.githubRepository.ensure();

					const searchResult = await octokit.call(octokit.api.search.code, {
						q: `${query} repo:${repoOwner}/${repoName}`,
						per_page: 5, // Limit results to avoid overwhelming
					});

					console.log(`GitHub search found ${searchResult.data.items.length} code results for "${query}"`);

					if (searchResult.data.items.length > 0) {
						const contextParts = searchResult.data.items.slice(0, 3).map(item => {
							return `File: ${item.path}\n${item.text_matches?.map(match => match.fragment).join('\n') || 'No text matches'}`;
						});

						codeContext += `\n--- GitHub Code Search results for "${query}" ---\n${contextParts.join('\n\n')}\n`;
					} else {
						console.log(`No code results found for "${query}"`);
					}
				} catch (searchError) {
					console.log(`GitHub API search failed for "${query}": ${searchError}`);
				}
			}

			const finalContext = codeContext.trim();
			console.log(`Final code context length: ${finalContext.length} characters`);
			return finalContext.length > 0 ? finalContext : undefined;
		} catch (error) {
			console.log(`DEBUG: getCodeContext failed with error: ${error}`);
			console.log(`DEBUG: getCodeContext error type: ${error?.constructor?.name}`);
			console.log(`DEBUG: getCodeContext error stack: ${error?.stack}`);
			return undefined;
		}
	}

	/**
	 * Use LM to generate intelligent search queries based on issue content
	 */
	private async generateSearchQueries(issue: IssueModel): Promise<string[]> {
		try {
			console.log(`DEBUG: generateSearchQueries called for issue #${issue.number}`);
			console.log(`Using LM to generate search queries for issue #${issue.number}`);

			const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
			console.log(`DEBUG: generateSearchQueries found ${models.length} language models`);
			if (models.length === 0) {
				console.log('No LM available for query generation, falling back to regex extraction');
				return this.extractSearchQueries(issue);
			}

			const model = models[0];
			const prompt = this.createSearchQueryPrompt(issue);

			const messages = [vscode.LanguageModelChatMessage.User(prompt)];
			const request = await model.sendRequest(messages, {
				justification: 'Generating search queries to find relevant code for issue complexity analysis'
			});

			let response = '';
			for await (const fragment of request.text) {
				response += fragment;
			}

			console.log(`LM search query response: ${response}`);
			const queries = this.parseSearchQueryResponse(response);
			console.log(`Parsed ${queries.length} search queries from LM`);

			return queries.length > 0 ? queries : this.extractSearchQueries(issue);
		} catch (error) {
			console.log(`DEBUG: generateSearchQueries failed with LM: ${error}`);
			console.log(`DEBUG: generateSearchQueries error type: ${error?.constructor?.name}`);
			console.log(`DEBUG: generateSearchQueries error stack: ${error?.stack}`);
			return this.extractSearchQueries(issue);
		}
	}

	/**
	 * Create a prompt for LM to generate GitHub search queries
	 */
	private createSearchQueryPrompt(issue: IssueModel): string {
		const labels = issue.item.labels?.map(label => label.name).join(', ') || 'None';

		return `Analyze this GitHub issue and generate 2-4 specific search queries to find relevant code in the repository.

Issue Details:
Title: ${issue.title}
Description: ${issue.body || 'No description provided'}
Labels: ${labels}

Guidelines for search queries:
- Focus on function names, class names, file names mentioned in the issue
- Look for error messages or stack traces if present
- Identify UI components or feature names
- Consider related functionality that might be affected
- Keep queries specific but not too narrow

Respond with ONLY a JSON array of search query strings, like:
["query1", "query2", "query3"]

Example good queries:
- "calculateComplexity function"
- "notebook cell editor"
- "markdown renderer"
- "file extension .tsx"`;
	}

	/**
	 * Parse LM response to extract search queries
	 */
	private parseSearchQueryResponse(response: string): string[] {
		try {
			// Try to extract JSON array from response
			const jsonMatch = response.match(/\[[\s\S]*?\]/);
			if (jsonMatch) {
				const parsed = JSON.parse(jsonMatch[0]);
				if (Array.isArray(parsed)) {
					return parsed.filter(q => typeof q === 'string' && q.length > 2).slice(0, 4);
				}
			}

			// Fallback: look for quoted strings
			const quotedStrings = response.match(/"([^"]+)"/g);
			if (quotedStrings) {
				return quotedStrings
					.map(s => s.replace(/"/g, ''))
					.filter(s => s.length > 2)
					.slice(0, 4);
			}

			console.log(`Could not parse search queries from LM response: ${response}`);
			return [];
		} catch (error) {
			console.log(`Error parsing search query response: ${error}`);
			return [];
		}
	}	/**
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
		if (codeContext && codeContext.trim().length > 0) {
			prompt += `

Code Context from Repository:
${codeContext}

IMPORTANT: Consider the above code context when assessing complexity. Your reasoning MUST reference the code findings. Look for:
- How many files/components would need to be modified
- The complexity of existing code that would be affected
- Dependencies between components
- Testing requirements based on the code structure
- Mention specific files or code patterns found in the search results`;
		} else {
			prompt += `

Note: No relevant code context was found in the repository for this issue, so the complexity assessment is based solely on the issue description and general software development experience.`;
		}

		prompt += `

Please respond with ONLY a JSON object in this format:
{
	"score": <number between 1-100>,
	"reasoning": "<brief explanation of why this score was chosen. If code context was provided, MUST mention specific files, code patterns, or implementation details found. If no code context, mention that assessment is based on issue description only.>"
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

			console.log(`Could not parse complexity response: ${response}`);
			return { score: -1 };
		} catch (error) {
			console.log(`Error parsing complexity response: ${error}`);
			return { score: -1 };
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
