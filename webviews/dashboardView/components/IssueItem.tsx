/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import React from 'react';
import { formatDate, formatFullDateTime, IssueData } from '../types';

interface IssueItemProps {
	issue: IssueData;
	onIssueClick: (issueUrl: string) => void;
	onStartRemoteAgent: (issue: IssueData, event: React.MouseEvent) => void;
}

export const IssueItem: React.FC<IssueItemProps> = ({
	issue,
	onIssueClick,
	onStartRemoteAgent,
}) => {
	return (
		<div
			key={issue.number}
			className="issue-item"
			onClick={() => onIssueClick(issue.url)}
		>
			<div className="item-title">
				<div className="issue-item-header">
					<div className="item-title">
						#{issue.number}: {issue.title}
					</div>
				</div>
				<button
					className="remote-agent-button"
					onClick={(e) => onStartRemoteAgent(issue, e)}
					title="Start remote agent for this issue"
				>
					<span className="codicon codicon-send-to-remote-agent"></span>
				</button>
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
