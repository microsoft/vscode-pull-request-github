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
import { DashboardState, vscode } from '../types';

const inputLanguageId = 'taskInput';

let suggestionDataSource: DashboardState | null = null;

function setupMonaco() {
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
				[/@(copilot|local)\b/, 'copilot-keyword'],
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
				const suggestions = suggestionDataSource?.state === 'ready' ? suggestionDataSource.milestoneIssues.map((issue): monaco.languages.CompletionItem => ({
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


interface ChatInputProps {
	readonly data: DashboardState | null;
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

			// Send all chat input to the provider for processing
			vscode.postMessage({
				command: 'submit-chat',
				args: { query: trimmedInput }
			});

			setChatInput('');
		}
	}, [chatInput]);

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
						placeholder: 'Ask a question or describe a coding task...',
						contextmenu: false,
						selectOnLineNumbers: false,
						automaticLayout: true
					}}
				/>
				<button
					className="send-button-inline"
					onClick={handleSendChat}
					disabled={!chatInput.trim()}
					title={
						isCopilotCommand(chatInput)
							? 'Start new remote Copilot chat (Ctrl+Enter)'
							: isLocalCommand(chatInput)
								? 'Start new local chat (Ctrl+Enter)'
								: 'Send message (Ctrl+Enter)'
					}
				>
					<span style={{ marginRight: '4px', fontSize: '12px' }}>
						{isCopilotCommand(chatInput)
							? 'Start remote task'
							: isLocalCommand(chatInput)
								? 'Start local task'
								: 'Send'
						}
					</span>
					<span className="codicon codicon-send"></span>
				</button>
			</div>

			<div className="quick-actions">
				<div
					className="quick-action-button"
					onClick={() => setChatInput('@copilot ')}
					title="Start a remote task with GitHub Copilot"
				>
					<span className="codicon codicon-robot"></span>
					<span>Start background task on GitHub</span>
				</div>
				<div
					className="quick-action-button"
					onClick={() => setChatInput('@local ')}
					title="Start a local task with branch creation"
				>
					<span className="codicon codicon-device-desktop"></span>
					<span>Start local task</span>
				</div>
			</div>
		</div>
	);
};

// Helper function to detect @copilot syntax
const isCopilotCommand = (text: string): boolean => {
	return text.trim().startsWith('@copilot');
};

// Helper function to detect @local syntax
const isLocalCommand = (text: string): boolean => {
	return text.trim().startsWith('@local');
};

setupMonaco();