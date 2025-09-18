/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import React from 'react';
import { formatDate, formatFullDateTime, SessionData, vscode } from '../types';

interface GlobalSessionItemProps {
	session: SessionData;
	index: number;
	onSessionClick: () => void;
	onPullRequestClick: (pullRequest: { number: number; title: string; url: string }) => void;
	isHighlighted?: boolean;
}

const handleLocalTaskClick = (session: SessionData) => {
	if (session.isLocal && session.id.startsWith('local-')) {
		const branchName = session.id.replace('local-', '');
		vscode.postMessage({
			command: 'switch-to-local-task',
			args: { branchName }
		});
	}
};

export const GlobalSessionItem: React.FC<GlobalSessionItemProps> = ({
	session,
	index,
	onSessionClick,
	onPullRequestClick,
	isHighlighted = false,
}) => {
	return (
		<div
			key={session.id}
			className={`session-item${session.isCurrentBranch ? ' current-branch' : ''}${session.isTemporary ? ' temporary-session' : ''}${session.isLocal ? ' local-task' : ''}${isHighlighted ? ' highlighted' : ''}`}
			onClick={session.isTemporary ? undefined : session.isLocal ? () => handleLocalTaskClick(session) : onSessionClick}
			title={session.isTemporary ?
				'Task is being created...' :
				session.isLocal ?
					`Click to switch to local task branch${session.isCurrentBranch ? ' (Current Branch)' : ''}` :
					session.pullRequest ?
						`Click to open pull request #${session.pullRequest.number} and chat session${session.isCurrentBranch ? ' (Current Branch)' : ''}` :
						`Click to open chat session${session.isCurrentBranch ? ' (Current Branch)' : ''}`
			}
		>
			<div className="item-title">
				{session.isCurrentBranch && (
					<span className="current-branch-indicator" title="Current branch">
						<span className="codicon codicon-git-branch"></span>
					</span>
				)}
				{session.isLocal && (
					<span className="task-type-indicator local" title="Local task">
						<span className="codicon codicon-device-desktop"></span>
					</span>
				)}
				{!session.isLocal && !session.isTemporary && (
					<span className="task-type-indicator remote" title="Remote copilot task">
						<span className="codicon codicon-robot"></span>
					</span>
				)}
				<span className="item-title-text">{session.title}</span>
			</div>
			<div className="item-metadata">
				{session.repository && (
					<div className="metadata-item">
						<span className="codicon codicon-repo"></span>
						<span className="repository-name">{session.repository}</span>
					</div>
				)}
				<div className="metadata-item">
					{session.isTemporary ? (
						<span className="status-badge status-creating">
							<span className="codicon codicon-loading codicon-modifier-spin"></span>
							{session.status}
						</span>
					) : session.isLocal ? (
						// No status badge for local tasks
						null
					) : (
						<span className={index === 0 && (session.status === '1' || session.status?.toLowerCase() === 'completed') ? 'status-badge status-needs-clarification' : getStatusBadgeClass(session.status)}>
							{(session.status === '2' || session.status?.toLowerCase() === 'in progress') && (
								<span className="codicon codicon-loading codicon-modifier-spin"></span>
							)}
							{(session.status === '1' || session.status?.toLowerCase() === 'completed') && (
								<span className="codicon codicon-circle-filled"></span>
							)}
							{formatStatus(session.status, index)}
						</span>
					)}
				</div>
				<div className="metadata-item">
					<span title={formatFullDateTime(session.dateCreated)}>{formatDate(session.dateCreated)}</span>
				</div>
				{session.isLocal && session.branchName && (
					<div className="metadata-item">
						<span className="codicon codicon-git-branch"></span>
						<span className="branch-name" title={`Branch: ${session.branchName}`}>{session.branchName}</span>
					</div>
				)}
				{session.pullRequest && (
					<div className="metadata-item">
						<button
							className="pull-request-link"
							onClick={(e) => {
								e.stopPropagation();
								onPullRequestClick(session.pullRequest!);
							}}
							style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
							title={`Open pull request #${session.pullRequest.number} only`}
						>
							PR #{session.pullRequest.number}
						</button>
					</div>
				)}
			</div>
		</div>
	);
};

const formatStatus = (status: string, index?: number) => {
	// Show 'needs clarification' for the first active task
	if (index === 0 && (status === '1' || status?.toLowerCase() === 'completed')) {
		return 'Needs clarification';
	}

	switch (status?.toLowerCase()) {
		case '0':
		case 'failed':
			return 'Failed';
		case '1':
		case 'completed':
			return 'Ready for review';
		case '2':
		case 'in progress':
			return 'In Progress';
		default:
			return status || 'Unknown';
	}
};

const getStatusBadgeClass = (status: string) => {
	switch (status?.toLowerCase()) {
		case '1':
		case 'completed':
			return 'status-badge status-completed';
		case '2':
		case 'in progress':
			return 'status-badge status-in-progress';
		case '0':
		case 'failed':
			return 'status-badge status-failed';
		default:
			return 'status-badge status-unknown';
	}
};