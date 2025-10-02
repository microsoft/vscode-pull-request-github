/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* eslint-disable import/no-unresolved */

import Editor, { Monaco } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import React, { useCallback, useEffect, useState } from 'react';
import { DashboardState } from '../types';
import { vscode } from '../util';
import { setupMonaco } from './monacoSupport';

export let suggestionDataSource: DashboardState | null = null;

interface ChatInputProps {
	data: DashboardState;
	value: string;
	onValueChange: (value: string) => void;
	focusTrigger?: number; // Increment this to trigger focus
	isSubmitting?: boolean; // Show progress spinner when true
}

export const ChatInput: React.FC<ChatInputProps> = ({ data, value, onValueChange, focusTrigger, isSubmitting = false }) => {
	const [editor, setEditor] = useState<monaco.editor.IStandaloneCodeEditor | null>(null);
	const [showDropdown, setShowDropdown] = useState(false);

	// Focus the editor when focusTrigger changes
	useEffect(() => {
		if (focusTrigger !== undefined && editor) {
			editor.focus();
			// Position cursor at the end
			const model = editor.getModel();
			if (model) {
				const position = model.getPositionAt(value.length);
				editor.setPosition(position);
			}
		}
	}, [focusTrigger, editor, value]);

	// Handle content changes from the editor
	const handleEditorChange = useCallback((newValue: string | undefined) => {
		onValueChange(newValue || '');
	}, [onValueChange]);

	const handleAgentClick = useCallback((agent: string) => {
		let finalInput: string;
		const currentInput = value.trim();

		if (!currentInput) {
			// Empty input - just set the agent
			finalInput = agent;
		} else {
			// Check if input starts with an agent pattern
			const agentMatch = currentInput.match(/^@(local|copilot)\s*/);
			if (agentMatch) {
				// Replace existing agent with the clicked one
				finalInput = agent + currentInput.substring(agentMatch[0].length);
			} else {
				// No agent at start - prepend the clicked agent
				finalInput = agent + currentInput;
			}
		}

		onValueChange(finalInput);
		if (editor) {
			editor.focus();
			// Position cursor at the end
			const model = editor.getModel();
			if (model) {
				const position = model.getPositionAt(finalInput.length);
				editor.setPosition(position);
			}
		}
	}, [value, editor, onValueChange]);

	const handleSendChat = useCallback(() => {
		if (value.trim()) {
			const trimmedInput = value.trim();

			// Send all chat input to the provider for processing
			vscode.postMessage({
				command: 'submit-chat',
				args: { query: trimmedInput }
			});

			// Don't clear the input here - it will be cleared when submission completes
		}
	}, [value]);



	// Handle dropdown option for planning task with local agent
	const handlePlanWithLocalAgent = useCallback(() => {
		if (value.trim()) {
			const trimmedInput = value.trim();
			// Remove @copilot prefix for planning with local agent and add @local prefix
			const cleanQuery = trimmedInput.replace(/@copilot\s*/, '').trim();
			const localQuery = `@local ${cleanQuery}`;

			// Send command to submit chat with local agent prefix
			vscode.postMessage({
				command: 'submit-chat',
				args: { query: localQuery }
			});

			// Don't clear the input here - it will be cleared when submission completes
			setShowDropdown(false);
		}
	}, [value]);

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
		setEditor(editorInstance);

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
					value={value}
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
						readOnly: isSubmitting,
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
				{isCopilotCommand(value) ? (
					<div className="send-button-container">
						<button
							className="send-button-inline split-left"
							onClick={handleSendChat}
							disabled={!value.trim() || isSubmitting}
							title="Start new remote Copilot task (Ctrl+Enter)"
						>
							<span style={{ marginRight: '4px', fontSize: '12px' }}>Start remote task</span>
							{isSubmitting ? (
								<span className="codicon codicon-loading codicon-modifier-spin"></span>
							) : (
								<span className="codicon codicon-send"></span>
							)}
						</button>
						<button
							className="send-button-inline split-right"
							onClick={(e) => {
								e.stopPropagation();
								setShowDropdown(!showDropdown);
							}}
							disabled={!value.trim() || isSubmitting}
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
						disabled={!value.trim() || isSubmitting}
						title={
							isLocalCommand(value)
								? 'Start new local task (Ctrl+Enter)'
								: 'Send message (Ctrl+Enter)'
						}
					>
						<span style={{ marginRight: '4px', fontSize: '12px' }}>
							{isLocalCommand(value)
								? 'Start local task'
								: 'Send'
							}
						</span>
						{isSubmitting ? (
							<span className="codicon codicon-loading codicon-modifier-spin"></span>
						) : (
							<span className="codicon codicon-send"></span>
						)}
					</button>
				)}
			</div>
		</div>

		<div className="quick-actions">
			<div className="global-instructions">
				<div className="instructions-content">
					<p>
						<strong>Reference issues:</strong> Use <code>#123</code> to start work on specific issues in this repo
					</p>
					<p>
						<strong>Choose your agent:</strong> Use <code
							style={{ cursor: 'pointer' }}
							onClick={() => handleAgentClick('@local ')}
							title="Click to add @local to input"
						>@local</code> to work locally or <code
							style={{ cursor: 'pointer' }}
							onClick={() => handleAgentClick('@copilot ')}
							title="Click to add @copilot to input"
						>@copilot</code> to use GitHub Copilot
					</p>
				</div>
			</div>
		</div>
	</>;
};
// Helper function to detect @copilot syntax
function isCopilotCommand(text: string): boolean {
	return text.trim().startsWith('@copilot');
}

// Helper function to detect @local syntax
function isLocalCommand(text: string): boolean {
	return text.trim().startsWith('@local');
}

setupMonaco();
