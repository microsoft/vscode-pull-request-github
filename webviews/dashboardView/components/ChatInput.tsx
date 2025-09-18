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
import { GlobalInstructions } from './GlobalInstructions';

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
				const suggestions = (suggestionDataSource?.state === 'ready' && !suggestionDataSource.isGlobal)
					? suggestionDataSource.milestoneIssues.map((issue: any): monaco.languages.CompletionItem => ({
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
	isGlobal: boolean;
	readonly data: DashboardState | null;
}

export const ChatInput: React.FC<ChatInputProps> = ({ data, isGlobal }) => {
	const [chatInput, setChatInput] = useState('');
	const [showDropdown, setShowDropdown] = useState(false);

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



	// Handle dropdown option for planning task with local agent
	const handlePlanWithLocalAgent = useCallback(() => {
		if (chatInput.trim()) {
			const trimmedInput = chatInput.trim();
			// Remove @copilot prefix for planning with local agent
			const cleanQuery = trimmedInput.replace(/@copilot\s*/, '').trim();

			// Send command to plan task with local agent
			vscode.postMessage({
				command: 'plan-task-with-local-agent',
				args: { query: cleanQuery }
			});

			setChatInput('');
			setShowDropdown(false);
		}
	}, [chatInput]);

	// Handle clicking outside dropdown to close it
	useEffect(() => {
		const handleClickOutside = (event: Event) => {
			const target = event.target as HTMLElement;
			if (!target.closest('.send-button-container')) {
				setShowDropdown(false);
			}
		};

		if (showDropdown) {
			document.addEventListener('click', handleClickOutside);
			return () => document.removeEventListener('click', handleClickOutside);
		}
	}, [showDropdown]);

	// Setup editor instance when it mounts
	const handleEditorDidMount = useCallback((editorInstance: monaco.editor.IStandaloneCodeEditor, monaco: Monaco) => {
		// Auto-resize editor based on content
		const updateHeight = () => {
			const model = editorInstance.getModel();
			if (model) {
				const lineCount = model.getLineCount();
				const lineHeight = editorInstance.getOption(monaco.editor.EditorOption.lineHeight);
				const containerHeight = Math.min(Math.max(lineCount * lineHeight + 16, 60), window.innerHeight * 0.3); // 16px for padding, min 60px, max 30vh

				const container = editorInstance.getContainerDomNode();
				if (container) {
					container.style.height = containerHeight + 'px';
					editorInstance.layout();
				}
			}
		};

		// Update height on content change
		editorInstance.onDidChangeModelContent(() => {
			requestAnimationFrame(updateHeight);
		});

		// Initial height adjustment
		requestAnimationFrame(updateHeight);

		// Handle keyboard shortcuts
		editorInstance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
			handleSendChat();
		});

		// Ensure paste command is available
		editorInstance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyV, () => {
			editorInstance.trigger('keyboard', 'editor.action.clipboardPasteAction', null);
		});

		// Focus the editor to ensure it can receive paste events
		editorInstance.focus();
	}, [handleSendChat]);

	useEffect(() => {
		suggestionDataSource = data;
	}, [data]);

	return <>
		<div className="chat-section">
			<div className="monaco-input-wrapper">
				<Editor
					key="task-input-editor"
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
				{isCopilotCommand(chatInput) ? (
					<div className="send-button-container">
						<button
							className="send-button-inline split-left"
							onClick={handleSendChat}
							disabled={!chatInput.trim()}
							title="Start new remote Copilot task (Ctrl+Enter)"
						>
							<span style={{ marginRight: '4px', fontSize: '12px' }}>Start remote task</span>
							<span className="codicon codicon-send"></span>
						</button>
						<button
							className="send-button-inline split-right"
							onClick={(e) => {
								e.stopPropagation();
								setShowDropdown(!showDropdown);
							}}
							disabled={!chatInput.trim()}
							title="More options"
						>
							<span className="codicon codicon-chevron-down"></span>
						</button>
						{showDropdown && (
							<div className="dropdown-menu">
								<button
									className="dropdown-item"
									onClick={handlePlanWithLocalAgent}
								>
									<span>Plan task with local agent</span>
									<span className="codicon codicon-comment-discussion" style={{ marginLeft: '8px' }}></span>
								</button>
							</div>
						)}
					</div>
				) : (
					<button
						className="send-button-inline"
						onClick={handleSendChat}
						disabled={!chatInput.trim()}
						title={
							isLocalCommand(chatInput)
								? 'Start new local task (Ctrl+Enter)'
								: 'Send message (Ctrl+Enter)'
						}
					>
						<span style={{ marginRight: '4px', fontSize: '12px' }}>
							{isLocalCommand(chatInput)
								? 'Start local task'
								: 'Send'
							}
						</span>
						<span className="codicon codicon-send"></span>
					</button>
				)}
			</div>
		</div>

		{isGlobal && <GlobalInstructions />}

		<div className="quick-actions">
			{!isGlobal && (
				<div className="global-instructions">
					<div className="instructions-content">
						<p>
							<strong>Reference issues:</strong> Use the syntax <code>org/repo#123</code> to start work on specific issues from any repository.
						</p>
						<p>
							<strong>Choose your agent:</strong> Use <code>@local</code> to work locally or <code>@copilot</code> to use GitHub Copilot.
						</p>
						<p>
							<strong>Mention projects:</strong> You can talk about projects by name to work across multiple repositories.
						</p>
					</div>
				</div>
			)}

			{/* Removed QuickActions for global dashboards - moved to input area separator only */}
		</div>
	</>;
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
