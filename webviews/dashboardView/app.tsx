/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as monaco from 'monaco-editor';
// @ts-expect-error - Worker imports with ?worker suffix are handled by bundler
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
// @ts-expect-error - a
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
// @ts-expect-error - a
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
// @ts-expect-error - a
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
// @ts-expect-error - a
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

import React, { useCallback, useEffect, useRef, useState } from 'react';

import Editor, { loader } from '@monaco-editor/react';
import { render } from 'react-dom';

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


interface SessionData {
	id: string;
	title: string;
	status: string;
	dateCreated: string;
	pullRequest?: {
		number: number;
		title: string;
		url: string;
	};
}

interface IssueData {
	number: number;
	title: string;
	assignee?: string;
	milestone?: string;
	state: string;
	url: string;
	createdAt: string;
	updatedAt: string;
	complexity?: number;
	complexityReasoning?: string;
}

interface DashboardData {
	activeSessions: SessionData[];
	milestoneIssues: IssueData[];
}

// eslint-disable-next-line rulesdir/no-any-except-union-method-signature
declare let acquireVsCodeApi: any;
const vscode = acquireVsCodeApi();

export function main() {
	render(<Dashboard />, document.getElementById('app'));
}

function Dashboard() {
	const [data, setData] = useState<DashboardData | null>(null);
	const [issuesLoading, setIssuesLoading] = useState(true);
	const [sessionsLoading, setSessionsLoading] = useState(true);
	const [refreshing, setRefreshing] = useState(false);
	const [issueSort, setIssueSort] = useState<'date-oldest' | 'date-newest' | 'complexity-low' | 'complexity-high'>('date-oldest');

	useEffect(() => {
		// Listen for messages from the extension
		const messageListener = (event: MessageEvent) => {
			// Handle both direct messages and wrapped messages
			const message = event.data?.res || event.data;
			if (!message || !message.command) {
				return; // Ignore messages without proper structure
			}

			switch (message.command) {
				case 'update-dashboard':
					setData(message.data);
					setIssuesLoading(false);
					setSessionsLoading(false);
					setRefreshing(false);
					break;
			}
		}; window.addEventListener('message', messageListener);

		// Request initial data
		vscode.postMessage({ command: 'ready' });

		vscode.postMessage({ command: 'refresh-dashboard' });

		return () => {
			window.removeEventListener('message', messageListener);
		};
	}, []);

	const handleRefresh = () => {
		setRefreshing(true);
		setIssuesLoading(true);
		setSessionsLoading(true);
		vscode.postMessage({ command: 'refresh-dashboard' });
	};

	const handleSessionClick = (sessionId: string) => {
		vscode.postMessage({
			command: 'open-session',
			args: { sessionId }
		});
	};

	const handleIssueClick = (issueUrl: string) => {
		vscode.postMessage({
			command: 'open-issue',
			args: { issueUrl }
		});
	};

	const handleStartRemoteAgent = (issue: any, event: React.MouseEvent) => {
		event.stopPropagation(); // Prevent triggering the issue click
		vscode.postMessage({
			command: 'start-remote-agent',
			args: { issue }
		});
	};

	const handlePullRequestClick = (pullRequest: { number: number; title: string; url: string }) => {
		vscode.postMessage({
			command: 'open-pull-request',
			args: { pullRequest }
		});
	};

	const formatDate = (dateString: string) => {
		if (!dateString) return 'Unknown';
		const date = new Date(dateString);
		return date.toLocaleDateString();
	};

	const getStatusBadgeClass = (status: string) => {
		switch (status?.toLowerCase()) {
			case 'completed':
			case '1':
				return 'status-badge status-completed';
			case 'in-progress':
			case 'inprogress':
			case '2':
				return 'status-badge status-in-progress';
			case 'failed':
			case '0':
				return 'status-badge status-failed';
			default:
				return 'status-badge status-in-progress';
		}
	};

	const formatStatus = (status: string, index?: number) => {
		// Show 'needs clarification' for the first active task
		if (index === 0 && (status === '1' || status?.toLowerCase() === 'completed')) {
			return 'Needs clarification';
		}

		switch (status?.toLowerCase()) {
			case '0':
				return 'Failed';
			case '1':
				return 'Ready for review';
			case 'completed':
				return 'Ready for review';
			case '2':
				return 'In Progress';
			default:
				return status || 'Unknown';
		}
	};

	// Sort issues based on selected option
	const getSortedIssues = useCallback((issues: IssueData[]) => {
		if (!issues) return [];

		const sortedIssues = [...issues];

		switch (issueSort) {
			case 'date-oldest':
				return sortedIssues.sort((a, b) => new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime());
			case 'date-newest':
				return sortedIssues.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
			case 'complexity-low':
				return sortedIssues.sort((a, b) => (a.complexity || 0) - (b.complexity || 0));
			case 'complexity-high':
				return sortedIssues.sort((a, b) => (b.complexity || 0) - (a.complexity || 0));
			default:
				return sortedIssues;
		}
	}, [issueSort]);

	return (
		<div className="dashboard-container">
			<div className="dashboard-header">
				<h1 className="dashboard-title">My Tasks</h1>
				<button className="refresh-button" onClick={handleRefresh} disabled={refreshing} title="Refresh dashboard">
					{refreshing ? (
						<span className="codicon codicon-sync codicon-modifier-spin"></span>
					) : (
						<span className="codicon codicon-refresh"></span>
					)}
				</button>
			</div>

			<div className="dashboard-content">
				{/* Left Column: Start new task */}
				<div className="dashboard-column">
					<h2 className="column-header">Start new task</h2>

					{/* Chat Input Section */}
					<ChatInput data={data} />

					<h3 className="column-header" style={{ marginTop: '24px' }}>September 2025 Issues</h3>
					{!issuesLoading && (
						<div className="section-header">
							<div className="section-count">
								{data?.milestoneIssues?.length || 0} issue{(data?.milestoneIssues?.length || 0) !== 1 ? 's' : ''}
							</div>
							<div className="sort-dropdown">
								<select
									value={issueSort}
									onChange={(e) => setIssueSort(e.target.value as any)}
									className="sort-select"
								>
									<option value="date-oldest">Date (oldest first)</option>
									<option value="date-newest">Date (newest first)</option>
									<option value="complexity-low">Complexity (lowest first)</option>
									<option value="complexity-high">Complexity (highest first)</option>
								</select>
							</div>
						</div>
					)}
					<div className="column-content">
						{issuesLoading ? (
							<div className="section-loading">
								<span className="codicon codicon-sync codicon-modifier-spin"></span>
								<span>Loading issues...</span>
							</div>
						) : !data?.milestoneIssues?.length ? (
							<div className="empty-state">
								No issues found for September 2025 milestone
							</div>
						) : (
							getSortedIssues(data.milestoneIssues).map((issue) => (
								<div
									key={issue.number}
									className="issue-item"
									onClick={() => handleIssueClick(issue.url)}
								>

									<div className="item-title">
										<div className="issue-item-header">
											<div className="item-title">
												#{issue.number}: {issue.title}
											</div>
											{issue.complexity && (
												<div
													className="complexity-score"
													title={issue.complexityReasoning || `Complexity score: ${issue.complexity}`}
												>
													{issue.complexity}
												</div>
											)}
										</div>
										<button
											className="remote-agent-button"
											onClick={(e) => handleStartRemoteAgent(issue, e)}
											title="Start remote agent for this issue"
										>
											<span className="codicon codicon-send-to-remote-agent"></span>
										</button>
									</div>
									<div className="item-metadata">
										{issue.assignee && (
											<div className="metadata-item">
												{/* allow-any-unicode-next-line */}
												<span>👤 {issue.assignee}</span>
											</div>
										)}
										{issue.milestone && (
											<div className="metadata-item">
												{/* allow-any-unicode-next-line */}
												<span>🎯 {issue.milestone}</span>
											</div>
										)}
										<div className="metadata-item">
											{/* allow-any-unicode-next-line */}
											<span>📅 Updated {formatDate(issue.updatedAt)}</span>
										</div>
									</div>
								</div>
							))
						)}
					</div>
				</div>

				{/* Right Column: Active tasks */}
				<div className="dashboard-column">
					<h2 className="column-header">Active tasks</h2>
					{!sessionsLoading && (
						<div className="section-count">
							{data?.activeSessions?.length || 0} task{(data?.activeSessions?.length || 0) !== 1 ? 's' : ''}
						</div>
					)}
					<div className="column-content">
						{sessionsLoading ? (
							<div className="section-loading">
								<span className="codicon codicon-sync codicon-modifier-spin"></span>
								<span>Loading sessions...</span>
							</div>
						) : !data?.activeSessions?.length ? (
							<div className="empty-state">
								No active sessions found
							</div>
						) : (
							data.activeSessions.map((session, index) => (
								<div
									key={session.id}
									className="session-item"
									onClick={() => handleSessionClick(session.id)}
								>
									<div className="item-title">{session.title}</div>
									<div className="item-metadata">
										<div className="metadata-item">
											<span className={index === 0 && (session.status === '1' || session.status?.toLowerCase() === 'completed') ? 'status-badge status-needs-clarification' : getStatusBadgeClass(session.status)}>
												{(session.status === '1' || session.status?.toLowerCase() === 'completed') && (
													<span className="codicon codicon-circle-filled"></span>
												)}
												{formatStatus(session.status, index)}
											</span>
										</div>
										<div className="metadata-item">
											<span className="codicon codicon-calendar"></span>
											<span>{formatDate(session.dateCreated)}</span>
										</div>
										{session.pullRequest && (
											<div className="metadata-item">
												<button
													className="pull-request-link"
													onClick={(e) => {
														e.stopPropagation();
														handlePullRequestClick(session.pullRequest!);
													}}
													style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
												>
													PR #{session.pullRequest.number}
												</button>
											</div>
										)}
									</div>
								</div>
							))
						)}
					</div>
				</div>
			</div>
		</div >
	);
}

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

// Monaco Editor Component
const ChatInput = ({ data }: { data: DashboardData | null }) => {
	const editorRef = useRef<any>(null);
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
	}, [chatInput]);

	// Setup editor instance when it mounts
	const handleEditorDidMount = useCallback((editor: any, monaco: any) => {
		editorRef.current = editor;

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
	const handleEditorWillMount = (monaco: any) => {
		// Register custom language for task input (only once)
		if (!monaco.languages.getLanguages().find((lang: any) => lang.id === 'taskInput')) {
			monaco.languages.register({ id: 'taskInput' });

			// Define syntax highlighting rules
			monaco.languages.setMonarchTokensProvider('taskInput', {
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
			monaco.languages.registerCompletionItemProvider('taskInput', {
				provideCompletionItems: (model: any, position: any) => {
					try {
						if (!model || model.isDisposed()) {
							return { suggestions: [] };
						}

						const textUntilPosition = model.getValueInRange({
							startLineNumber: position.lineNumber,
							startColumn: 1,
							endLineNumber: position.lineNumber,
							endColumn: position.column
						});

						// Check if user is typing after #
						const hashMatch = textUntilPosition.match(/#\d*$/);
						if (hashMatch) {
							const suggestions = data?.milestoneIssues?.map(issue => ({
								label: `#${issue.number}`,
								kind: monaco.languages.CompletionItemKind.Reference,
								insertText: `${issue.number}`,
								detail: issue.title,
								documentation: `Issue #${issue.number}: ${issue.title}\nAssignee: ${issue.assignee || 'None'}\nMilestone: ${issue.milestone || 'None'}`,
								range: {
									startLineNumber: position.lineNumber,
									startColumn: position.column - hashMatch[0].length + 1,
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
					} catch (error) {
						// Model was disposed or invalid, return empty suggestions
						return { suggestions: [] };
					}
				}
			});
		}
	};

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
					beforeMount={handleEditorWillMount}
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
						// Enable clipboard operations
						readOnly: false,
						domReadOnly: false,
						// Ensure paste functionality works
						contextmenu: true,
						// Enable all selection and editing features
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
