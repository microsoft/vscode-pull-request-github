/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import React from 'react';
import { IssueData, SessionData } from '../types';
import { formatDate, formatFullDateTime } from '../util';

interface IssueItemProps {
	issue: IssueData;
	onIssueClick: (issueUrl: string) => void;
	onPopulateLocalInput: (issue: IssueData, event: React.MouseEvent) => void;
	onPopulateRemoteInput: (issue: IssueData, event: React.MouseEvent) => void;
	onSwitchToLocalTask?: (branchName: string, event: React.MouseEvent) => void;
	associatedSession?: SessionData;
	onSessionClick?: (session: SessionData) => void;
	onPullRequestClick?: (pullRequest: { number: number; title: string; url: string }) => void;
	onHover?: () => void;
	onHoverEnd?: () => void;
	currentBranch?: string;
}

export const IssueItem: React.FC<IssueItemProps> = ({
	issue,
	onIssueClick,
	onPopulateLocalInput,
	onPopulateRemoteInput,
	onSwitchToLocalTask,
	associatedSession,
	onSessionClick,
	onPullRequestClick,
	onHover,
	onHoverEnd,
	currentBranch,
}) => {
	// Check if we're currently on the branch for this issue
	const isOnIssueBranch = currentBranch && issue.localTaskBranch && currentBranch === issue.localTaskBranch;
	return (
		<div
			key={issue.number}
			className="issue-item"
			onClick={() => onIssueClick(issue.url)}
			onMouseEnter={onHover}
			onMouseLeave={onHoverEnd}
		>
			<div className="item-title">
				<div className="issue-item-header">
					<div className="item-title">
						#{issue.number}: {issue.title}
					</div>
				</div>
				{associatedSession ? (
					<div className="session-actions">
						{associatedSession.pullRequest ? (
							<button
								className="pr-link-button"
								onClick={(e) => {
									e.stopPropagation();
									if (onPullRequestClick) {
										onPullRequestClick(associatedSession.pullRequest!);
									}
								}}
								title={`Open PR #${associatedSession.pullRequest.number} (Remote task)`}
							>
								<span className="codicon codicon-robot"></span>
								<span>PR #{associatedSession.pullRequest.number}</span>
							</button>
						) : (
							<button
								className="session-link-button"
								onClick={(e) => {
									e.stopPropagation();
									if (onSessionClick) {
										onSessionClick(associatedSession);
									}
								}}
								title="Open associated remote session"
							>
								<span className="codicon codicon-robot"></span>
								<span>Session</span>
							</button>
						)}
					</div>
				) : isOnIssueBranch ? (
					<div className="session-actions">
						<span className="active-badge" title="Currently working on this issue">
							<span className="codicon codicon-circle-filled"></span>
							<span>Active</span>
						</span>
					</div>
				) : issue.localTaskBranch ? (
					<div className="session-actions">
						{issue.pullRequest ? (
							<button
								className="pr-link-button"
								onClick={(e) => {
									e.stopPropagation();
									if (onPullRequestClick) {
										onPullRequestClick(issue.pullRequest!);
									}
								}}
								title={`Open PR #${issue.pullRequest.number} (Local task)`}
							>
								<span className="codicon codicon-device-desktop"></span>
								<span>PR #{issue.pullRequest.number}</span>
							</button>
						) : (
							<button
								className="session-link-button"
								onClick={(e) => {
									e.stopPropagation();
									if (onSwitchToLocalTask) {
										onSwitchToLocalTask(issue.localTaskBranch!, e);
									}
								}}
								title={`Switch to existing branch: ${issue.localTaskBranch}`}
							>
								<span className="codicon codicon-device-desktop"></span>
								<span>{issue.localTaskBranch}</span>
							</button>
						)}
					</div>
				) : (
					<div className="session-actions">
						<button
							className="session-start-button local-task-button"
							onClick={(e) => onPopulateLocalInput(issue, e)}
							title="Populate input with local task command"
						>
							<span className="codicon codicon-device-desktop"></span>
							<span>Start Local</span>
						</button>
						<button
							className="session-start-button coding-agent-task-button"
							onClick={(e) => onPopulateRemoteInput(issue, e)}
							title="Populate input with remote agent command"
						>
							<span className="codicon codicon-robot"></span>
							<span>Start Remote</span>
						</button>
					</div>
				)}
			</div>
			<div className="item-metadata">
				{issue.assignee && (
					<div className="metadata-item">
						<span className="codicon codicon-account"></span>
						<span>{issue.assignee}</span>
					</div>
				)}
				{issue.milestone && (
					<div className="metadata-item">
						<span className="codicon codicon-milestone"></span>
						<span>{issue.milestone}</span>
					</div>
				)}
				<div className="metadata-item">
					<span title={formatFullDateTime(issue.updatedAt)}>Updated {formatDate(issue.updatedAt)}</span>
				</div>
			</div>
		</div>
	);
};
