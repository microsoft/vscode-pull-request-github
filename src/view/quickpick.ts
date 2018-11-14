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
		public description,
		public remote?: Remote,
		public label = `${owner}:${name}`,
	) {}
}

export class BranchQuickPickItem implements vscode.QuickPickItem {
	label: string;
	description?: string;
	detail?: string;
	picked?: boolean;

	constructor(
		public owner: string,
		public repo: string,
		public defaultBranch: string
	) {
		this.label = defaultBranch;
		this.description = `${owner}/${repo}`;
	}
}
