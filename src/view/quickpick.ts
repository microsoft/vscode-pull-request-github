/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Remote } from '../common/remote';

export class RemoteQuickPickItem implements vscode.QuickPickItem {
	detail?: string;
	picked?: boolean;

	static fromRemote(remote: Remote) {
		return new this(remote.owner, remote.repositoryName, remote.url, remote);
	}

	constructor(
		public owner: string,
		public name: string,
		public description: string,
		public remote?: Remote,
		public label = `${owner}:${name}`,
	) {}
}

export type PullRequestNameSource = 'commit' | 'branch' | 'custom' | 'ask';

export class PullRequestNameSourceQuickPick implements vscode.QuickPickItem {
	static allOptions(): PullRequestNameSourceQuickPick[] {
		const values: PullRequestNameSource[] = ['commit', 'branch', 'custom'];
		return values.map(x => this.fromPullRequestNameSource(x));
	}
	static getDescription(pullRequestNameSource: PullRequestNameSource): string {
		switch (pullRequestNameSource) {
			case 'commit':
				return 'Use the latest commit message';
			case 'branch':
				return 'Use the branch name';
			case 'custom':
				return 'Specify a custom message';
		}
		return '';
	}
	static fromPullRequestNameSource(pullRequestNameSource: PullRequestNameSource) {
		return new this(this.getDescription(pullRequestNameSource), pullRequestNameSource, pullRequestNameSource);
	}
	constructor(public description: string, public pullRequestNameSource: PullRequestNameSource, public label: string) { }
}

