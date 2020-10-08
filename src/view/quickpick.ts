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
	) { }
}

export type PullRequestTitleSource = 'commit' | 'branch' | 'custom' | 'ask';

export enum PullRequestTitleSourceEnum {
	Commit = 'commit',
	Branch = 'branch',
	Custom = 'custom',
	Ask = 'ask'
}

export class PullRequestTitleSourceQuickPick implements vscode.QuickPickItem {
	static allOptions(): PullRequestTitleSourceQuickPick[] {
		const values: PullRequestTitleSource[] = [
			PullRequestTitleSourceEnum.Commit,
			PullRequestTitleSourceEnum.Branch,
			PullRequestTitleSourceEnum.Custom
		];
		return values.map(x => this.fromPullRequestTitleSource(x));
	}
	static getDescription(pullRequestTitleSource: PullRequestTitleSource): string {
		switch (pullRequestTitleSource) {
			case PullRequestTitleSourceEnum.Commit:
				return 'Use the latest commit message';
			case PullRequestTitleSourceEnum.Branch:
				return 'Use the branch name';
			case PullRequestTitleSourceEnum.Custom:
				return 'Specify a custom title';
		}
		return '';
	}
	static fromPullRequestTitleSource(pullRequestTitleSource: PullRequestTitleSource) {
		return new this(this.getDescription(pullRequestTitleSource), pullRequestTitleSource, pullRequestTitleSource);
	}
	constructor(public description: string, public pullRequestTitleSource: PullRequestTitleSource, public label: string) { }
}

export type PullRequestDescriptionSource = 'template' | 'commit' | 'custom' | 'ask';

export enum PullRequestDescriptionSourceEnum {
	Template = 'template',
	Commit = 'commit',
	Custom = 'custom',
	Ask = 'ask'
}

export class PullRequestDescriptionSourceQuickPick implements vscode.QuickPickItem {
	static allOptions(): PullRequestDescriptionSourceQuickPick[] {
		const values: PullRequestDescriptionSource[] = [
			PullRequestDescriptionSourceEnum.Template,
			PullRequestDescriptionSourceEnum.Commit,
			PullRequestDescriptionSourceEnum.Custom
		];
		return values.map(x => this.fromPullRequestDescriptionSource(x));
	}
	static getDescription(pullRequestDescriptionSource: PullRequestDescriptionSource): string {
		switch (pullRequestDescriptionSource) {
			case PullRequestDescriptionSourceEnum.Template:
				return 'Use a pull request template, or use the commit description if no templates were found';
			case PullRequestDescriptionSourceEnum.Commit:
				return 'Use the latest commit message';
			case PullRequestDescriptionSourceEnum.Custom:
				return 'Specify a custom description';
		}
		return '';
	}
	static fromPullRequestDescriptionSource(pullRequestDescriptionSource: PullRequestDescriptionSource) {
		return new this(this.getDescription(pullRequestDescriptionSource), pullRequestDescriptionSource, pullRequestDescriptionSource);
	}
	constructor(public description: string, public pullRequestDescriptionSource: PullRequestDescriptionSource, public label: string) { }
}
