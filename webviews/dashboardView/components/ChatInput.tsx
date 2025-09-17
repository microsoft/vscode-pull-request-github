/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* eslint-disable import/no-unresolved */

import Editor, { loader, Monaco } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
// @ts-expect-error - Worker imports with ?worker suffix are handled by bundler
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
// @ts-expect-error - a
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
// @ts-expect-error - a
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
// @ts-expect-error - a
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
// @ts-expect-error - a
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
import React, { useCallback, useEffect, useState } from 'react';
import { DashboardData, IssueData, vscode } from '../types';

const inputLanguageId = 'taskInput';

let suggestionDataSource: DashboardData | null = null;

function setupMonaco() {
	// eslint-disable-next-line rulesdir/no-any-except-union-method-signature
	(self as any).MonacoEnvironment = {
		getWorker(_: string, label: string): Worker {
			if (label === 'json') {
				return new jsonWorker();
			}
			if (label === 'css' || label === 'scss' || label === 'less') {
				return new cssWorker();
			}
			if (label === 'html' || label === 'handlebars' || label === 'razor') {
				return new htmlWorker();
			}
			if (label === 'typescript' || label === 'javascript') {
				return new tsWorker();
			}
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
				[/[@]copilot\b/, 'copilot-keyword'],
				[/#\d+/, 'issue-reference'],
				[/.*/, 'text']
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
			{ token: 'text', foreground: 'cccccc' }
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
				const suggestions = suggestionDataSource?.milestoneIssues?.map((issue): monaco.languages.CompletionItem => ({
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
				})) || [];

				return { suggestions };
			}

			// Provide @copilot suggestion
			if (textUntilPosition.match(/@\w*$/)) {
				return {
					suggestions: [{
						label: '@copilot',
						kind: monaco.languages.CompletionItemKind.Keyword,
						insertText: 'copilot ',
						detail: 'Start a new Copilot task',
						documentation: 'Begin a task description that will be sent to Copilot with full context',
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


interface ChatInputProps {
	readonly data: DashboardData | null;
}

export const ChatInput: React.FC<ChatInputProps> = ({ data }) => {
	const [chatInput, setChatInput] = useState('');

	// Handle content changes
	const handleEditorChange = useCallback((value: string | undefined) => {
		setChatInput(value || '');
	}, []);

	const handleSendChat = useCallback(() => {
		if (chatInput.trim()) {
			const trimmedInput = chatInput.trim();

			// Check if this is a @copilot command
			if (isCopilotCommand(trimmedInput)) {
				// Extract the task description (remove @copilot prefix)
				const taskDescription = trimmedInput.replace(/^@copilot\s*/, '');

				// Extract issue references
				const referencedIssues = extractIssueNumbers(taskDescription);
				const issueContext = referencedIssues.map(issueNum => findIssueByNumber(data, issueNum)).filter(Boolean);

				// Start a new copilot session with issue context
				vscode.postMessage({
					command: 'start-copilot-task',
					args: {
						taskDescription,
						referencedIssues,
						issueContext
					}
				});
			} else {
				// Regular chat command
				vscode.postMessage({
					command: 'open-chat',
					args: { query: trimmedInput }
				});
			}

			setChatInput('');
		}
	}, [chatInput, data]);

	// Setup editor instance when it mounts
	const handleEditorDidMount = useCallback((editor: monaco.editor.IStandaloneCodeEditor, monaco: Monaco) => {
		// Handle keyboard shortcuts
		editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
			handleSendChat();
		});

		// Ensure paste command is available
		editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyV, () => {
			editor.trigger('keyboard', 'editor.action.clipboardPasteAction', null);
		});

		// Focus the editor to ensure it can receive paste events
		editor.focus();
	}, [handleSendChat]);

	useEffect(() => {
		suggestionDataSource = data;
	}, [data]);

	return (
		<div className="chat-section">
			<div className="monaco-input-wrapper">
				<Editor
					key="task-input-editor"
					height="60px"
					defaultLanguage="taskInput"
					value={chatInput}
					theme="taskInputTheme"
					loading={null}
					onMount={handleEditorDidMount}
					onChange={handleEditorChange}
					options={{
						minimap: { enabled: false },
						lineNumbers: 'off',
						glyphMargin: false,
						folding: false,
						lineDecorationsWidth: 0,
						lineNumbersMinChars: 0,
						scrollBeyondLastLine: false,
						wordWrap: 'on',
						overviewRulerBorder: false,
						overviewRulerLanes: 0,
						hideCursorInOverviewRuler: true,
						colorDecorators: false,
						scrollbar: {
							vertical: 'auto',
							horizontal: 'hidden',
							verticalScrollbarSize: 8
						},
						suggest: {
							showKeywords: false,
							showSnippets: false,
							showWords: false
						},
						occurrencesHighlight: 'off',
						placeholder: 'Type @copilot to start a new task, or type a message to chat...',
						contextmenu: false,
						selectOnLineNumbers: false,
						automaticLayout: true
					}}
				/>
				<button
					className="send-button-inline"
					onClick={handleSendChat}
					disabled={!chatInput.trim()}
					title="Send message (Ctrl+Enter)"
				>
					<span className="codicon codicon-send"></span>
				</button>
			</div>

			{isCopilotCommand(chatInput) && (
				<div className="copilot-hint">
					<span className="codicon codicon-robot"></span>
					<span>Starting new Copilot task</span>
					{extractIssueNumbers(chatInput).length > 0 && (
						<span className="issue-references">
							{` with ${extractIssueNumbers(chatInput).length} issue reference${extractIssueNumbers(chatInput).length > 1 ? 's' : ''}`}
						</span>
					)}
				</div>
			)}
			<p style={{ fontSize: '12px', color: 'var(--vscode-descriptionForeground)', marginTop: '4px' }}>
				Press Ctrl+Enter (Cmd+Enter on Mac) to send
			</p>
		</div>
	);
};

// Helper function to detect @copilot syntax
const isCopilotCommand = (text: string): boolean => {
	return text.trim().startsWith('@copilot');
};

// Helper function to find issue data by number
const findIssueByNumber = (data: DashboardData | null, issueNumber: number): IssueData | undefined => {
	return data?.milestoneIssues?.find(issue => issue.number === issueNumber);
};

// Helper function to extract issue numbers from text
const extractIssueNumbers = (text: string): number[] => {
	const issueRegex = /#(\d+)/g;
	const matches: number[] = [];
	let match;
	while ((match = issueRegex.exec(text)) !== null) {
		matches.push(parseInt(match[1], 10));
	}
	return matches;
};

setupMonaco();