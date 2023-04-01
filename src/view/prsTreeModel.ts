/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ITelemetry } from '../common/telemetry';
import { createPRNodeIdentifier } from '../common/uri';
import { dispose } from '../common/utils';
import { FolderRepositoryManager, ItemsResponseResult } from '../github/folderRepositoryManager';
import { CheckState, PRType, PullRequestChecks, PullRequestReviewRequirement } from '../github/interface';
import { PullRequestModel } from '../github/pullRequestModel';

export enum UnsatisfiedChecks {
	None = 0,
	ReviewRequired = 1 << 0,
	ChangesRequested = 1 << 1,
	CIFailed = 1 << 2,
	CIPending = 1 << 3
}

interface PRStatusChange {
	pullRequest: PullRequestModel;
	status: UnsatisfiedChecks;
}

export class PrsTreeModel implements vscode.Disposable {
	private readonly _disposables: vscode.Disposable[] = [];
	private readonly _onDidChangePrStatus: vscode.EventEmitter<string[]> = new vscode.EventEmitter();
	public readonly onDidChangePrStatus = this._onDidChangePrStatus.event;

	// Key is identifier from createPRNodeUri
	private readonly _queriedPullRequests: Map<string, PRStatusChange> = new Map();

	constructor(private _telemetry: ITelemetry) {

	}

	public cachedPRStatus(identifier: string): PRStatusChange | undefined {
		return this._queriedPullRequests.get(identifier);
	}

	private async _getChecks(pullRequests: PullRequestModel[]) {
		// If there are too many pull requests then we could hit our internal rate limit
		// or even GitHub's secondary rate limit. If there are more than 100 PRs,
		// chunk them into 100s.
		let checks: [PullRequestChecks | null, PullRequestReviewRequirement | null][] = [];
		for (let i = 0; i < pullRequests.length; i += 100) {
			const sliceEnd = (i + 100 < pullRequests.length) ? i + 100 : pullRequests.length;
			checks.push(...await Promise.all(pullRequests.slice(i, sliceEnd).map(pullRequest => {
				return pullRequest.getStatusChecks();
			})));
		}

		const changedStatuses: string[] = [];
		for (let i = 0; i < pullRequests.length; i++) {
			const pullRequest = pullRequests[i];
			const [check, reviewRequirement] = checks[i];
			let newStatus: UnsatisfiedChecks = UnsatisfiedChecks.None;

			if (reviewRequirement) {
				if (reviewRequirement.state === CheckState.Failure) {
					newStatus |= UnsatisfiedChecks.ReviewRequired;
				} else if (reviewRequirement.state == CheckState.Pending) {
					newStatus |= UnsatisfiedChecks.ChangesRequested;
				}
			}

			if (!check || check.state === CheckState.Unknown) {
				continue;
			}
			if (check.state !== CheckState.Success) {
				for (const status of check.statuses) {
					if (status.state === CheckState.Failure) {
						newStatus |= UnsatisfiedChecks.CIFailed;
					} else if (status.state === CheckState.Pending) {
						newStatus |= UnsatisfiedChecks.CIPending;
					}
				}
				if (newStatus === UnsatisfiedChecks.None) {
					newStatus |= UnsatisfiedChecks.CIPending;
				}
			}
			const identifier = createPRNodeIdentifier(pullRequest);
			const oldState = this._queriedPullRequests.get(identifier);
			if ((oldState === undefined) || (oldState.status !== newStatus)) {
				const newState = { pullRequest, status: newStatus };
				changedStatuses.push(identifier);
				this._queriedPullRequests.set(identifier, newState);
			}
		}
		this._onDidChangePrStatus.fire(changedStatuses);
	}

	async getLocalPullRequests(folderRepoManager: FolderRepositoryManager) {
		const prs = await folderRepoManager.getLocalPullRequests();
		/* __GDPR__
			"pr.expand.local" : {}
		*/
		this._telemetry.sendTelemetryEvent('pr.expand.local');
		// Don't await this._getChecks. It fires an event that will be listened to.
		this._getChecks(prs);
		return prs;
	}

	async getPullRequestsForQuery(folderRepoManager: FolderRepositoryManager, fetchNextPage: boolean, query: string): Promise<ItemsResponseResult<PullRequestModel>> {
		const prs = await folderRepoManager.getPullRequests(
			PRType.Query,
			{ fetchNextPage },
			query,
		);
		/* __GDPR__
			"pr.expand.query" : {}
		*/
		this._telemetry.sendTelemetryEvent('pr.expand.query');
		// Don't await this._getChecks. It fires an event that will be listened to.
		this._getChecks(prs.items);
		return prs;
	}

	async getAllPullRequests(folderRepoManager: FolderRepositoryManager, fetchNextPage: boolean): Promise<ItemsResponseResult<PullRequestModel>> {
		const prs = await folderRepoManager.getPullRequests(
			PRType.All,
			{ fetchNextPage }
		);

		/* __GDPR__
			"pr.expand.all" : {}
		*/
		this._telemetry.sendTelemetryEvent('pr.expand.all');
		// Don't await this._getChecks. It fires an event that will be listened to.
		this._getChecks(prs.items);
		return prs;
	}

	dispose() {
		dispose(this._disposables);
	}

}