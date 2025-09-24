/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import React from 'react';
import { formatDate, formatFullDateTime, IssueData, SessionData } from '../types';

interface IssueItemProps {
	issue: IssueData;
	onIssueClick: (issueUrl: string) => void;
	onPopulateLocalInput: (issue: IssueData, event: React.MouseEvent) => void;
	onPopulateRemoteInput: (issue: IssueData, event: React.MouseEvent) => void;
	associatedSession?: SessionData;
	onSessionClick?: (session: SessionData) => void;
	onPullRequestClick?: (pullRequest: { number: number; title: string; url: string }) => void;
	onHover?: () => void;
	onHoverEnd?: () => void;
}

export const IssueItem: React.FC<IssueItemProps> = ({
	issue,
	onIssueClick,
	onPopulateLocalInput,
	onPopulateRemoteInput,
	associatedSession,
	onSessionClick,
	onPullRequestClick,
	onHover,
	onHoverEnd,
}) => {
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
					<div className="associated-session-info">
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
						{associatedSession.pullRequest && (
							<button
								className="pr-link-button"
								onClick={(e) => {
									e.stopPropagation();
									if (onPullRequestClick) {
										onPullRequestClick(associatedSession.pullRequest!);
									}
								}}
								title={`Open PR #${associatedSession.pullRequest.number}`}
							>
								<span>PR #{associatedSession.pullRequest.number}</span>
							</button>
						)}
					</div>
				) : (
					<div className="task-buttons">
						<button
							className="local-task-button"
							onClick={(e) => onPopulateLocalInput(issue, e)}
							title="Populate input with local task command"
						>
							<span className="codicon codicon-repo-clone"></span>
							<span>Local</span>
						</button>
						<button
							className="coding-agent-task-button"
							onClick={(e) => onPopulateRemoteInput(issue, e)}
							title="Populate input with remote agent command"
						>
							<span className="codicon codicon-robot"></span>
							<span>Remote</span>
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
