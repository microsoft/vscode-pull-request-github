/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import React, { useCallback, useEffect, useState } from 'react';

import { render } from 'react-dom';
import { ChatInput } from './components/ChatInput';
import { EmptyState } from './components/EmptyState';
import { FilterButton, FilterState } from './components/FilterButton';
import { GlobalSessionItem } from './components/GlobalSessionItem';
import { IssueItem } from './components/IssueItem';
import { LoadingState } from './components/LoadingState';
import { SessionItem } from './components/SessionItem';
import { SortDropdown } from './components/SortDropdown';
import { DashboardState, extractMilestoneFromQuery, IssueData, ProjectData, SessionData, vscode } from './types';

export function main() {
	render(<Dashboard />, document.getElementById('app'));
}

// Check if a session is associated with a specific issue
function isSessionAssociatedWithIssue(session: SessionData, issue: IssueData): boolean {
	if (session.isLocal) return false;

	// Use the same logic as findAssociatedSession
	const sessionTitle = session.title.toLowerCase();
	const issueNumber = `#${issue.number}`;
	const issueTitle = issue.title.toLowerCase();

	// Match by issue number reference or similar title
	return sessionTitle.includes(issueNumber) ||
		sessionTitle.includes(issueTitle) ||
		issueTitle.includes(sessionTitle);
}

function Dashboard() {
	const [dashboardState, setDashboardState] = useState<DashboardState | null>(null);
	const [refreshing, setRefreshing] = useState(false);
	const [issueSort, setIssueSort] = useState<'date-oldest' | 'date-newest'>('date-oldest');
	const [hoveredIssue, setHoveredIssue] = useState<IssueData | null>(null);
		const [globalFilter, setGlobalFilter] = useState<FilterState>({ showTasks: true, showProjects: true });

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
			command: 'open-session-with-pr',
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

	const handleStartRemoteAgent = useCallback((issue: any, event: React.MouseEvent) => {
		event.stopPropagation(); // Prevent triggering the issue click
		vscode.postMessage({
			command: 'start-remote-agent',
			args: { issue }
		});
	}, []);

	const handlePullRequestClick = useCallback((pullRequest: { number: number; title: string; url: string }) => {
		vscode.postMessage({
			command: 'open-pull-request',
			args: { pullRequest }
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

	// Derived state from discriminated union
	const isGlobal = dashboardState?.isGlobal;
	const issueQuery = !isGlobal && dashboardState ? dashboardState.issueQuery || '' : '';
	const milestoneIssues = !isGlobal && dashboardState?.state === 'ready' && !dashboardState.isGlobal ? dashboardState.milestoneIssues : [];
	const activeSessions = dashboardState?.state === 'ready' ? dashboardState.activeSessions : [];
	const recentProjects = isGlobal && dashboardState?.state === 'ready' && dashboardState.isGlobal ? dashboardState.recentProjects : [];

	// For global dashboards, create a mixed array of sessions and projects
	const mixedItems = isGlobal ? (() => {
		const mixed: Array<{ type: 'session', data: SessionData, index: number } | { type: 'project', data: ProjectData }> = [];

		// Add sessions based on filter
		if (globalFilter.showTasks) {
			activeSessions.forEach((session, index) => {
				mixed.push({ type: 'session', data: session, index });
			});
		}

		// Add projects based on filter
		if (globalFilter.showProjects) {
			recentProjects.forEach((project: ProjectData) => {
				mixed.push({ type: 'project', data: project });
			});
		}

		function shuffle<T>(array: T[]): T[] {
			for (let i = array.length - 1; i > 0; i--) {
				const j = Math.floor(Math.random() * (i + 1));
				const tmp = array[i];
				array[i] = array[j];
				array[j] = tmp;
			}
			return array;
		}

		shuffle(mixed);

		// Sort by recency - sessions first, then projects, but could be enhanced with actual timestamps
		return mixed;
	})() : [];

	return (
		<div className={`dashboard-container${isGlobal ? ' global-dashboard' : ''}`}>
			{!isGlobal && (
				<div className={`dashboard-header${isGlobal ? ' global-header' : ''}`}>
					<h1 className="dashboard-title">
						{isGlobal ? 'Visual Studio Code - Insiders' : 'My Tasks'}
					</h1>
					<button className="refresh-button" onClick={handleRefresh} disabled={refreshing} title="Refresh dashboard">
						{refreshing ? (
							<span className="codicon codicon-sync codicon-modifier-spin"></span>
						) : (
							<span className="codicon codicon-refresh"></span>
						)}
					</button>
				</div>
			)}

			<div className={`dashboard-content${isGlobal ? ' global-dashboard' : ''}`}>
				{/* Input Area */}
				<div className="input-area">
					<h2 className="area-header">Start new task</h2>
					<ChatInput data={dashboardState} isGlobal={!!isGlobal} />

				</div>

				{/* Issues/Projects Area */}
				<div className="issues-area">
					{isGlobal ? (
						<>
							{/* Empty for now, everything moved to tasks area */}
						</>
					) : (
						<>
							<div className="area-header milestone-header">
								<h3
									className="milestone-title"
									title={`Issue Query: ${issueQuery}`}
								>
									{issueQuery ? extractMilestoneFromQuery(issueQuery) : 'Issues'}
								</h3>
								{dashboardState?.state === 'ready' && (
									<SortDropdown
										issueSort={issueSort}
										onSortChange={setIssueSort}
									/>
								)}
							</div>
							{dashboardState?.state === 'ready' && (
								<div className="section-count">
									{milestoneIssues.length || 0} issue{milestoneIssues.length !== 1 ? 's' : ''}
								</div>
							)}
							<div className="area-content">
								{dashboardState?.state === 'loading' ? (
									<LoadingState message="Loading issues..." />
								) : dashboardState?.state === 'ready' && !milestoneIssues.length ? (
									<EmptyState message={`No issues found for ${issueQuery ? extractMilestoneFromQuery(issueQuery).toLowerCase() : 'issues'}`} />
								) : dashboardState?.state === 'ready' ? (
									getSortedIssues(milestoneIssues).map((issue) => {
										const associatedSession = findAssociatedSession(issue);
										return (
											<IssueItem
												key={issue.number}
												issue={issue}
												onIssueClick={handleIssueClick}
												onStartRemoteAgent={handleStartRemoteAgent}
												associatedSession={associatedSession}
												onSessionClick={handleSessionClick}
												onPullRequestClick={handlePullRequestClick}
												onHover={() => setHoveredIssue(issue)}
												onHoverEnd={() => setHoveredIssue(null)}
											/>
										);
									})
								) : null}
							</div>
						</>
					)}
				</div>

				{/* Tasks Area */}
				<div className="tasks-area">
					<div className="area-header-container">
						<h2 className="area-header">{isGlobal ? 'Continue working on...' : 'Active tasks'}</h2>
						{isGlobal && (
							<FilterButton
								filterState={globalFilter}
								onFilterChange={setGlobalFilter}
							/>
						)}
					</div>
					{dashboardState?.state === 'ready' && (
						<div className="section-count">
							{activeSessions.length || 0} task{activeSessions.length !== 1 ? 's' : ''}
						</div>
					)}
					<div className="area-content">
						{dashboardState?.state === 'loading' ? (
							<LoadingState message="Loading tasks..." />
						) : dashboardState?.state === 'ready' && !activeSessions.length && (!isGlobal || !recentProjects.length) ? (
							<EmptyState message="No active tasks found" />
						) : dashboardState?.state === 'ready' ? (
							<>
								{isGlobal ? (
									// Render mixed items for global dashboard
									mixedItems.map((item) =>
										item.type === 'session' ? (
											<GlobalSessionItem
												key={item.data.id}
												session={item.data}
												index={item.index}
												onSessionClick={() => handleSessionClick(item.data)}
												onPullRequestClick={handlePullRequestClick}
											/>
										) : (
											<div
												key={`project-${item.data.path}`}
												className="session-item project-item"
												onClick={() => vscode.postMessage({ command: 'open-project', args: { path: item.data.path } })}
												title={`Click to open project: ${item.data.name}`}
											>
												<div className="item-title">
													<span className="task-type-indicator project" title="Recent project">
														<span className="codicon codicon-folder-opened"></span>
													</span>
													<span className="item-title-text">{item.data.name}</span>
												</div>
												{item.data.path && (
													<div className="item-metadata">
														<div className="metadata-item">
															<span className="project-path-text">{item.data.path}</span>
														</div>
													</div>
												)}
											</div>
										)
									)
								) : (
									// Render sessions only for regular dashboard
									activeSessions.map((session, index) => (
										<SessionItem
											key={session.id}
											session={session}
											index={index}
											onSessionClick={() => handleSessionClick(session)}
											onPullRequestClick={handlePullRequestClick}
											isHighlighted={hoveredIssue !== null && isSessionAssociatedWithIssue(session, hoveredIssue)}
										/>
									))
								)}
							</>
						) : null}
					</div>
				</div>
			</div>
		</div >
	);
}
