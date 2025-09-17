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
import { DashboardData, IssueData, vscode } from './types';

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
							<SortDropdown
								issueSort={issueSort}
								onSortChange={setIssueSort}
							/>
						</div>
					)}
					<div className="column-content">
						{issuesLoading ? (
							<LoadingState message="Loading issues..." />
						) : !data?.milestoneIssues?.length ? (
							<EmptyState message="No issues found for September 2025 milestone" />
						) : (
							getSortedIssues(data.milestoneIssues).map((issue) => (
								<IssueItem
									key={issue.number}
									issue={issue}
									onIssueClick={handleIssueClick}
									onStartRemoteAgent={handleStartRemoteAgent}
									formatDate={formatDate}
								/>
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
							<LoadingState message="Loading sessions..." />
						) : !data?.activeSessions?.length ? (
							<EmptyState message="No active sessions found" />
						) : (
							data.activeSessions.map((session, index) => (
								<SessionItem
									key={session.id}
									session={session}
									index={index}
									onSessionClick={handleSessionClick}
									onPullRequestClick={handlePullRequestClick}
									formatDate={formatDate}
									getStatusBadgeClass={getStatusBadgeClass}
									formatStatus={formatStatus}
								/>
							))
						)}
					</div>
				</div>
			</div>
		</div >
	);
}
