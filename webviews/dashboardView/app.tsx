/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import React, { useEffect, useState } from 'react';
import { render } from 'react-dom';

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
	complexityScore?: {
		score: number;
		reasoning: string;
		calculatedAt: string;
	};
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

type SortMethod = 'none' | 'complexity-asc' | 'complexity-desc';

function Dashboard() {
	const [data, setData] = useState<DashboardData | null>(null);
	const [loading, setLoading] = useState(true);
	const [chatInput, setChatInput] = useState('');
	const [sortMethod, setSortMethod] = useState<SortMethod>('none');

	useEffect(() => {
		// Listen for messages from the extension
		const messageListener = (event: MessageEvent) => {
			const message = event.data.res;
			switch (message.command) {
				case 'update-dashboard':
					setData(message.data);
					setLoading(false);
					break;
			}
		};

		window.addEventListener('message', messageListener);

		// Request initial data
		vscode.postMessage({ command: 'ready' });

		vscode.postMessage({ command: 'refresh-dashboard' });

		return () => {
			window.removeEventListener('message', messageListener);
		};
	}, []);

	const handleRefresh = () => {
		setLoading(true);
		vscode.postMessage({ command: 'refresh-dashboard' });
	};

	const handleSendChat = () => {
		if (chatInput.trim()) {
			vscode.postMessage({
				command: 'open-chat',
				args: { query: chatInput.trim() }
			});
			setChatInput('');
		}
	};

	const handleSessionClick = (sessionId: string) => {
		vscode.postMessage({
			command: 'open-session',
			args: { sessionId }
		});
	};

	const handleIssueClick = (issue: IssueData) => {
		vscode.postMessage({
			command: 'open-issue',
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

	const formatStatus = (status: string) => {
		switch (status?.toLowerCase()) {
			case '0':
				return 'Failed';
			case '1':
				return 'Completed';
			case '2':
				return 'In Progress';
			default:
				return status || 'Unknown';
		}
	};

	const getComplexityColor = (score: number) => {
		if (score <= 20) {
			// allow-any-unicode-next-line
			return '#28a745';
		} else if (score <= 40) {
			// allow-any-unicode-next-line
			return '#ffc107';
		} else if (score <= 60) {
			// allow-any-unicode-next-line
			return '#fd7e14';
		} else if (score <= 80) {
			// allow-any-unicode-next-line
			return '#dc3545';
		} else {
			// allow-any-unicode-next-line
			return '#6f42c1';
		}
	};

	const sortIssues = (issues: IssueData[]): IssueData[] => {
		if (sortMethod === 'none') {
			return issues;
		}

		return [...issues].sort((a, b) => {
			const scoreA = a.complexityScore?.score ?? 0;
			const scoreB = b.complexityScore?.score ?? 0;

			if (sortMethod === 'complexity-asc') {
				return scoreA - scoreB;
			} else {
				return scoreB - scoreA;
			}
		});
	};

	const toggleSort = () => {
		setSortMethod(current => {
			switch (current) {
				case 'none':
					return 'complexity-desc';
				case 'complexity-desc':
					return 'complexity-asc';
				case 'complexity-asc':
					return 'none';
				default:
					return 'none';
			}
		});
	};

	const getSortIcon = () => {
		switch (sortMethod) {
			case 'complexity-desc':
				return '🔽'; // High to low
			case 'complexity-asc':
				return '🔼'; // Low to high
			default:
				return '⚪'; // No sort
		}
	};

	const getSortTooltip = () => {
		switch (sortMethod) {
			case 'complexity-desc':
				return 'Sorted by complexity (high to low). Click to sort low to high.';
			case 'complexity-asc':
				return 'Sorted by complexity (low to high). Click to remove sorting.';
			default:
				return 'Not sorted by complexity. Click to sort high to low.';
		}
	};

	if (loading) {
		return (
			<div className="dashboard-container">
				<div className="loading-indicator">Loading dashboard...</div>
			</div>
		);
	}

	return (
		<div className="dashboard-container">
			<div className="dashboard-header">
				<h1 className="dashboard-title">My Tasks</h1>
				<button className="refresh-button" onClick={handleRefresh}>
					Refresh
				</button>
			</div>

			<div className="dashboard-content">
				{/* Left Column: Start new task */}
				<div className="dashboard-column">
					<h2 className="column-header">Start new task</h2>

					{/* Chat Input Section */}
					<div className="chat-section">
						<div className="chat-input-container">
							<textarea
								className="chat-input"
								placeholder="Start working on a new task..."
								value={chatInput}
								onChange={(e) => setChatInput(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
										handleSendChat();
									}
								}}
							/>
							<button
								className="send-button"
								onClick={handleSendChat}
								disabled={!chatInput.trim()}
							>
								Send
							</button>
						</div>
						<p style={{ fontSize: '12px', color: 'var(--vscode-descriptionForeground)', marginTop: '4px' }}>
							Press Ctrl+Enter (Cmd+Enter on Mac) to send
						</p>
					</div>

					<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '24px' }}>
						<h3 className="column-header" style={{ margin: 0 }}>September 2025 Issues</h3>
						<button
							className="sort-button"
							onClick={toggleSort}
							title={getSortTooltip()}
							style={{
								background: 'none',
								border: '1px solid var(--vscode-button-border)',
								borderRadius: '3px',
								padding: '4px 8px',
								cursor: 'pointer',
								color: 'var(--vscode-button-foreground)',
								fontSize: '12px',
								display: 'flex',
								alignItems: 'center',
								gap: '4px'
							}}
							onMouseOver={(e) => {
								e.currentTarget.style.backgroundColor = 'var(--vscode-button-hoverBackground)';
							}}
							onMouseOut={(e) => {
								e.currentTarget.style.backgroundColor = 'transparent';
							}}
						>
							{/* allow-any-unicode-next-line */}
							<span>{getSortIcon()}</span>
							<span>Sort</span>
						</button>
					</div>
					<div className="column-content">
						{!data?.milestoneIssues?.length ? (
							<div className="empty-state">
								No issues found for September 2025 milestone
							</div>
						) : (
							sortIssues(data.milestoneIssues).map((issue) => (
								<div
									key={issue.number}
									className="issue-item"
									onClick={() => handleIssueClick(issue)}
								>
									<div className="item-title">
										#{issue.number}: {issue.title}
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
										{issue.complexityScore && (
											<div className="metadata-item">
												<span
													className="complexity-badge"
													style={{
														backgroundColor: getComplexityColor(issue.complexityScore.score),
														color: 'white',
														padding: '2px 6px',
														borderRadius: '3px',
														fontSize: '11px',
														fontWeight: 'bold',
														display: 'inline-block'
													}}
													title={`Complexity: ${issue.complexityScore.score}/100\n\n${issue.complexityScore.reasoning}`}
												>
													{issue.complexityScore.score}
												</span>
											</div>
										)}
									</div>
								</div>
							))
						)}
					</div>
				</div>

				{/* Right Column: Active tasks */}
				<div className="dashboard-column">
					<h2 className="column-header">Active tasks</h2>
					<div className="column-content">
						{!data?.activeSessions?.length ? (
							<div className="empty-state">
								No active sessions found
							</div>
						) : (
							data.activeSessions.map((session) => (
								<div
									key={session.id}
									className="session-item"
									onClick={() => handleSessionClick(session.id)}
								>
									<div className="item-title">{session.title}</div>
									<div className="item-metadata">
										<div className="metadata-item">
											<span className={getStatusBadgeClass(session.status)}>
												{formatStatus(session.status)}
											</span>
										</div>
										<div className="metadata-item">
											{/* allow-any-unicode-next-line */}
											<span>📅 {formatDate(session.dateCreated)}</span>
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
		</div>
	);
}
