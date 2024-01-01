/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { PullRequest } from '../../src/github/views';
import { vscode } from './message';

export function getState(): PullRequest {
	return vscode.getState();
}

export function setState(pullRequest: PullRequest): void {
	const oldPullRequest = getState();

	if (oldPullRequest && oldPullRequest.number && oldPullRequest.number === pullRequest.number) {
		pullRequest.pendingCommentText = oldPullRequest.pendingCommentText;
	}

	if (pullRequest) {
		vscode.setState(pullRequest);
	}
}

export function updateState(data: Partial<PullRequest>): void {
	const pullRequest = vscode.getState();
	vscode.setState(Object.assign(pullRequest, data));
}
