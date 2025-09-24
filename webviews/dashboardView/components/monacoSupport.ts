/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* eslint-disable import/no-unresolved */

import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
// @ts-expect-error - Worker imports with ?worker suffix are handled by bundler
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import { DashboardReady } from '../types';
import { suggestionDataSource } from './ChatInput';

/**
 * Language id used for that chat input on the dashboard
 */
const inputLanguageId = 'taskInput';

export function setupMonaco() {
	(self as any).MonacoEnvironment = {
		getWorker(_: string, _label: string): Worker {
			// Only support generic editor worker
			return new editorWorker();
		},
	};

	// Configure Monaco loader - use local monaco instance to avoid worker conflicts
	loader.config({ monaco, });

	// Register language for input
	monaco.languages.register({ id: inputLanguageId });

	// Define syntax highlighting rules
	monaco.languages.setMonarchTokensProvider(inputLanguageId, {
		tokenizer: {
			root: [
				[/@(copilot|local)\b/, 'copilot-keyword'],
				[/#\d+/, 'issue-reference'],
				[/\w+\/\w+#\d+/, 'issue-reference'],
			]
		}
	});

	// Define theme colors
	monaco.editor.defineTheme('taskInputTheme', {
		base: 'vs-dark',
		inherit: true,
		rules: [
			{ token: 'copilot-keyword', foreground: '569cd6', fontStyle: 'bold' },
			{ token: 'issue-reference', foreground: 'ffd700' },
		],
		colors: {}
	});

	// Setup autocomplete provider
	monaco.languages.registerCompletionItemProvider(inputLanguageId, {
		triggerCharacters: ['#', '@'],
		provideCompletionItems: (model, position) => {
			const textUntilPosition = model.getValueInRange({
				startLineNumber: position.lineNumber,
				startColumn: 1,
				endLineNumber: position.lineNumber,
				endColumn: position.column
			});

			// Check if user is typing after #
			const hashMatch = textUntilPosition.match(/#\d*$/);
			if (hashMatch) {
				const suggestions = (suggestionDataSource?.state === 'ready' && !suggestionDataSource.isGlobal)
					? (suggestionDataSource as DashboardReady).milestoneIssues.map((issue: any): monaco.languages.CompletionItem => ({
						label: `#${issue.number}`,
						kind: monaco.languages.CompletionItemKind.Reference,
						insertText: `#${issue.number}`,
						detail: issue.title,
						documentation: `Issue #${issue.number}: ${issue.title}\nAssignee: ${issue.assignee || 'None'}\nMilestone: ${issue.milestone || 'None'}`,
						range: {
							startLineNumber: position.lineNumber,
							startColumn: position.column - hashMatch[0].length,
							endLineNumber: position.lineNumber,
							endColumn: position.column
						}
					})) : [];

				return { suggestions };
			}

			// Provide @copilot and @local suggestions
			if (textUntilPosition.match(/@\w*$/)) {
				return {
					suggestions: [{
						label: '@copilot',
						kind: monaco.languages.CompletionItemKind.Keyword,
						insertText: 'copilot ',
						detail: 'Start a new remote Copilot task',
						documentation: 'Begin a task description that will be sent to Copilot to work remotely on GitHub',
						range: {
							startLineNumber: position.lineNumber,
							startColumn: Math.max(1, position.column - (textUntilPosition.match(/@\w*$/)?.[0]?.length || 0)),
							endLineNumber: position.lineNumber,
							endColumn: position.column
						}
					}, {
						label: '@local',
						kind: monaco.languages.CompletionItemKind.Keyword,
						insertText: 'local ',
						detail: 'Start a new local task',
						documentation: 'Begin a task description that will create a new branch and work locally in your environment',
						range: {
							startLineNumber: position.lineNumber,
							startColumn: Math.max(1, position.column - (textUntilPosition.match(/@\w*$/)?.[0]?.length || 0)),
							endLineNumber: position.lineNumber,
							endColumn: position.column
						}
					}]
				};
			}

			return { suggestions: [] };
		}
	});
}