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
import { DashboardState, extractMilestoneFromQuery, IssueData, SessionData, vscode } from './types';

export function main() {
	render(<Dashboard />, document.getElementById('app'));
}

function Dashboard() {
	const [dashboardState, setDashboardState] = useState<DashboardState | null>(null);
	const [refreshing, setRefreshing] = useState(false);
	const [issueSort, setIssueSort] = useState<'date-oldest' | 'date-newest'>('date-oldest');

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

	const handleRefresh = () => {
		setRefreshing(true);
		vscode.postMessage({ command: 'refresh-dashboard' });
	};

	const handleSessionClick = (session: SessionData) => {
		vscode.postMessage({
			command: 'open-session-with-pr',
			args: {
				sessionId: session.id,
				pullRequest: session.pullRequest
			}
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

	// Derived state from discriminated union
	const issueQuery = dashboardState?.issueQuery || '';
	const milestoneIssues = dashboardState?.state === 'ready' ? dashboardState.milestoneIssues : [];
	const activeSessions = dashboardState?.state === 'ready' ? dashboardState.activeSessions : [];

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
					<ChatInput data={dashboardState} />

					<h3
						className="column-header milestone-header"
						style={{ marginTop: '24px' }}
						title={`Issue Query: ${issueQuery}`}
					>
						{issueQuery ? extractMilestoneFromQuery(issueQuery) : 'Issues'}
					</h3>
					{dashboardState?.state === 'ready' && (
						<div className="section-header">
							<div className="section-count">
								{milestoneIssues.length || 0} issue{milestoneIssues.length !== 1 ? 's' : ''}
							</div>
							<SortDropdown
								issueSort={issueSort}
								onSortChange={setIssueSort}
							/>
						</div>
					)}
					<div className="column-content">
						{dashboardState?.state === 'loading' ? (
							<LoadingState message="Loading issues..." />
						) : dashboardState?.state === 'ready' && !milestoneIssues.length ? (
							<EmptyState message={`No issues found for ${issueQuery ? extractMilestoneFromQuery(issueQuery).toLowerCase() : 'issues'}`} />
						) : dashboardState?.state === 'ready' ? (
							getSortedIssues(milestoneIssues).map((issue) => (
								<IssueItem
									key={issue.number}
									issue={issue}
									onIssueClick={handleIssueClick}
									onStartRemoteAgent={handleStartRemoteAgent}
								/>
							))
						) : null}
					</div>
				</div>

				{/* Right Column: Active tasks */}
				<div className="dashboard-column">
					<h2 className="column-header">Active tasks</h2>
					{dashboardState?.state === 'ready' && (
						<div className="section-count">
							{activeSessions.length || 0} task{activeSessions.length !== 1 ? 's' : ''}
						</div>
					)}
					<div className="column-content">
						{dashboardState?.state === 'loading' ? (
							<LoadingState message="Loading sessions..." />
						) : dashboardState?.state === 'ready' && !activeSessions.length ? (
							<EmptyState message="No active sessions found" />
						) : dashboardState?.state === 'ready' ? (
							activeSessions.map((session, index) => (
								<SessionItem
									key={session.id}
									session={session}
									index={index}
									onSessionClick={() => handleSessionClick(session)}
									onPullRequestClick={handlePullRequestClick}
								/>
							))
						) : null}
					</div>
				</div>
			</div>
		</div >
	);
}
