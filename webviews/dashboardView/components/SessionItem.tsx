/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import React from 'react';
import { SessionData } from '../types';

interface SessionItemProps {
	session: SessionData;
	index: number;
	onSessionClick: (sessionId: string) => void;
	onPullRequestClick: (pullRequest: { number: number; title: string; url: string }) => void;
	formatDate: (dateString: string) => string;
	getStatusBadgeClass: (status: string) => string;
	formatStatus: (status: string, index?: number) => string;
}

export const SessionItem: React.FC<SessionItemProps> = ({
	session,
	index,
	onSessionClick,
	onPullRequestClick,
	formatDate,
	getStatusBadgeClass,
	formatStatus
}) => {
	return (
		<div
			key={session.id}
			className="session-item"
			onClick={() => onSessionClick(session.id)}
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
								onPullRequestClick(session.pullRequest!);
							}}
							style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
						>
							PR #{session.pullRequest.number}
						</button>
					</div>
				)}
			</div>
		</div>
	);
};