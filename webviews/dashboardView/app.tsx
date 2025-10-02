/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import React, { useCallback, useEffect, useState } from 'react';

import { render } from 'react-dom';
import { ChatInput } from './components/ChatInput';
import { EmptyState } from './components/EmptyState';
import { IssueItem } from './components/IssueItem';
import { LoadingState } from './components/LoadingState';
import { SessionItem } from './components/SessionItem';
import { SortDropdown } from './components/SortDropdown';
import { DashboardReady, DashboardState, IssueData, SessionData } from './types';
import { extractMilestoneFromQuery, vscode } from './util';

export function main() {
	render(<Dashboard />, document.getElementById('app'));
}

function Dashboard() {
	const [dashboardState, setDashboardState] = useState<DashboardState | null>(null);
	const [refreshing, setRefreshing] = useState(false);
	const [issueSort, setIssueSort] = useState<'date-oldest' | 'date-newest'>('date-oldest');
	const [hoveredIssue, setHoveredIssue] = useState<IssueData | null>(null);
	const [chatInputValue, setChatInputValue] = useState('');
	const [focusTrigger, setFocusTrigger] = useState(0);
	const [isChatSubmitting, setIsChatSubmitting] = useState(false);

	useEffect(() => {
		// Listen for messages from the extension
		const messageListener = (event: MessageEvent) => {
			// Handle both direct messages and wrapped messages
			const message = event.data?.res || event.data;
			if (!message || !message.command) {
				return; // Ignore messages without proper structure
			}
			switch (message.command) {
				case 'initialize':
					setDashboardState(message.data);
					break;
				case 'update-dashboard':
					setDashboardState(message.data);
					setRefreshing(false);
					break;
				case 'chat-submission-started':
					setIsChatSubmitting(true);
					break;
				case 'chat-submission-completed':
					setIsChatSubmitting(false);
					// Clear the chat input when submission completes
					setChatInputValue('');
					break;
			}
		};
		window.addEventListener('message', messageListener);

		vscode.postMessage({ command: 'ready' });

		return () => {
			window.removeEventListener('message', messageListener);
		};
	}, []);

	const handleRefresh = useCallback(() => {
		setRefreshing(true);
		vscode.postMessage({ command: 'refresh-dashboard' });
	}, []);

	const handleSessionClick = useCallback((session: SessionData) => {
		vscode.postMessage({
			command: 'switch-to-remote-task',
			args: {
				sessionId: session.id,
				pullRequest: session.pullRequest
			}
		});
	}, []);

	const handleIssueClick = useCallback((issueUrl: string) => {
		vscode.postMessage({
			command: 'open-issue',
			args: { issueUrl }
		});
	}, []);

	const handlePopulateLocalInput = useCallback((issue: any, event: React.MouseEvent) => {
		event.stopPropagation(); // Prevent triggering the issue click
		const command = `@local start work on #${issue.number}`;
		setChatInputValue(command);
		setFocusTrigger(prev => prev + 1); // Trigger focus
		// Scroll to top to show the input box
		window.scrollTo({ top: 0, behavior: 'smooth' });
	}, []);

	const handlePopulateRemoteInput = useCallback((issue: any, event: React.MouseEvent) => {
		event.stopPropagation(); // Prevent triggering the issue click
		const command = `@copilot start work on #${issue.number}`;
		setChatInputValue(command);
		setFocusTrigger(prev => prev + 1); // Trigger focus
		// Scroll to top to show the input box
		window.scrollTo({ top: 0, behavior: 'smooth' });
	}, []);

	const handlePullRequestClick = useCallback((pullRequest: { number: number; title: string; url: string }) => {
		vscode.postMessage({
			command: 'open-pull-request',
			args: { pullRequest }
		});
	}, []);

	const handleIssueCountClick = useCallback(() => {
		if (dashboardState?.state === 'ready') {
			const readyState = dashboardState as DashboardReady;
			const { owner, name } = readyState.repository || { owner: '', name: '' };

			if (owner && name) {
				const githubQuery = readyState.issueQuery;

				const githubUrl = `https://github.com/${owner}/${name}/issues?q=${encodeURIComponent(githubQuery)}`;
				vscode.postMessage({
					command: 'open-external-url',
					args: { url: githubUrl }
				});
			}
		}
	}, [dashboardState]);

	const handleSwitchToLocalTask = useCallback((branchName: string, event: React.MouseEvent) => {
		event.stopPropagation(); // Prevent triggering the issue click
		vscode.postMessage({
			command: 'switch-to-local-task',
			args: { branchName }
		});
	}, []);

	const handleSwitchToMain = useCallback(() => {
		vscode.postMessage({
			command: 'switch-to-main'
		});
	}, []);

	// Sort issues based on selected option
	const getSortedIssues = useCallback((issues: readonly IssueData[]) => {
		if (!issues) return [];

		const sortedIssues = [...issues];

		switch (issueSort) {
			case 'date-oldest':
				return sortedIssues.sort((a, b) => new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime());
			case 'date-newest':
				return sortedIssues.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
			default:
				return sortedIssues;
		}
	}, [issueSort]);

	// Find associated session for an issue based on title matching or issue references
	const findAssociatedSession = useCallback((issue: IssueData): SessionData | undefined => {
		if (dashboardState?.state !== 'ready') return undefined;

		return dashboardState.activeSessions.find(session => {
			// Skip local sessions
			if (session.isLocal) return false;

			// Check if session title contains the issue number
			const sessionTitle = session.title.toLowerCase();
			const issueNumber = `#${issue.number}`;
			const issueTitle = issue.title.toLowerCase();

			// Match by issue number reference or similar title
			return sessionTitle.includes(issueNumber) ||
				sessionTitle.includes(issueTitle) ||
				issueTitle.includes(sessionTitle);
		});
	}, [dashboardState]);

	// Derived state from discriminated union with proper type narrowing
	const isReady = dashboardState?.state === 'ready';
	const readyState = isReady ? dashboardState as DashboardReady : null;

	const issueQuery = readyState?.issueQuery || '';
	const milestoneIssues = readyState?.milestoneIssues || [];
	const activeSessions = isReady ? dashboardState.activeSessions : [];
	const currentBranch = readyState?.currentBranch; return (
		<div className="dashboard-container">
			<div className="dashboard-header">
				<h1 className="dashboard-title">My Tasks</h1>
				<div className="header-buttons">
					{readyState?.currentBranch &&
						readyState.currentBranch !== 'main' &&
						readyState.currentBranch !== 'master' && (
							<button
								className="switch-to-main-button"
								onClick={handleSwitchToMain}
								title={`Switch from ${readyState.currentBranch} to main`}
							>
								<span className="codicon codicon-git-branch"></span>
								<span>Switch to main</span>
							</button>
						)}
					<button className="refresh-button" onClick={handleRefresh} disabled={refreshing} title="Refresh dashboard">
						<span className={`codicon ${refreshing ? 'codicon-sync codicon-modifier-spin' : 'codicon-refresh'}`}></span>
					</button>
				</div>
			</div>

			<div className="dashboard-content">
				{/* Input Area */}
				<div className="input-area">
					<h2 className="area-header new-task">Start new task</h2>
					<ChatInput
						data={dashboardState}
						value={chatInputValue}
						onValueChange={setChatInputValue}
						focusTrigger={focusTrigger}
						isSubmitting={isChatSubmitting}
					/>
				</div>

				{/* Issues/Projects Area */}
				<div className="issues-area">
					<div className="area-header milestone-header">
						<h3
							className="milestone-title"
							title={`Issue Query: ${issueQuery}`}
						>
							{issueQuery ? extractMilestoneFromQuery(issueQuery) : 'Issues'}
						</h3>
						{isReady && (
							<SortDropdown
								issueSort={issueSort}
								onSortChange={setIssueSort}
							/>
						)}
					</div>
					{isReady && (
						<div
							className="section-count clickable-count"
							onClick={handleIssueCountClick}
							title="Click to open GitHub issues"
						>
							{milestoneIssues.length || 0} issue{milestoneIssues.length !== 1 ? 's' : ''}
						</div>
					)}
					<div className="area-content">
						{dashboardState?.state === 'loading' ? (
							<LoadingState message="Loading issues..." />
						) : isReady && !milestoneIssues.length ? (
							<EmptyState message={`No issues found for ${issueQuery ? extractMilestoneFromQuery(issueQuery).toLowerCase() : 'issues'}`} />
						) : isReady ? (
							getSortedIssues(milestoneIssues).map((issue) => {
								const associatedSession = findAssociatedSession(issue);
								return (
									<IssueItem
										key={issue.number}
										issue={issue}
										onIssueClick={handleIssueClick}
										onPopulateLocalInput={handlePopulateLocalInput}
										onPopulateRemoteInput={handlePopulateRemoteInput}
										onSwitchToLocalTask={handleSwitchToLocalTask}
										associatedSession={associatedSession}
										onSessionClick={handleSessionClick}
										onPullRequestClick={handlePullRequestClick}
										onHover={() => setHoveredIssue(issue)}
										onHoverEnd={() => setHoveredIssue(null)}
										currentBranch={currentBranch}
									/>
								);
							})
						) : null}
					</div>
				</div>

				{/* Tasks Area */}
				<div className="tasks-area">
					<div className="area-header-container">
						<h2 className="area-header">
							{isReady ?
								`${activeSessions.length || 0} active task${activeSessions.length !== 1 ? 's' : ''}` :
								'Active tasks'
							}
						</h2>
					</div>
					<div className="area-content">
						{dashboardState?.state === 'loading' ? (
							<LoadingState message="Loading tasks..." />
						) : isReady && !activeSessions.length ? (
							<EmptyState message="No active tasks found" />
						) : isReady ? (
							activeSessions.map((session, index) => (
								<SessionItem
									key={session.id}
									session={session}
									index={index}
									onSessionClick={() => handleSessionClick(session)}
									onPullRequestClick={handlePullRequestClick}
									isHighlighted={hoveredIssue !== null && findAssociatedSession(hoveredIssue)?.id === session.id}
								/>
							))
						) : null}
					</div>
				</div>
			</div>
		</div>
	);
}
