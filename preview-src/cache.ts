/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { vscode } from './message';
import { PullRequestStateEnum, TimelineEvent } from './pullRequestOverviewRenderer';

export interface PullRequest {
	number: number;
	title: string;
	url: string;
	createdAt: Date;
	body: string;
	author: any;
	state: PullRequestStateEnum;
	events: TimelineEvent[];
	isCurrentlyCheckedOut: boolean;
	base: string;
	head: string;
	labels: string[];
	commitsCount: number;
	repositoryDefaultBranch: any;
	canEdit: boolean;
	pendingCommentText?: string;
	pendingCommentDrafts?: { [key: string]: string; };
}

export function getState(): PullRequest {
	return vscode.getState() || {};
}

export function setState(pullRequest: PullRequest): void {
	vscode.setState(pullRequest);
}

export function updateState(data: Partial<PullRequest>): void {
	const pullRequest = vscode.getState();
	vscode.setState(Object.assign(pullRequest, data));
}
