/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Remote } from '../common/remote';

export class RemoteQuickPickItem implements vscode.QuickPickItem {
	label: string;
	description?: string;
	detail?: string;
	picked?: boolean;

	constructor(
		public remote: Remote
	) {
		this.label = remote.remoteName;
		this.description = remote.url;
	}
}

export class BranchQuickPickItem implements vscode.QuickPickItem {
	label: string;
	description?: string;
	detail?: string;
	picked?: boolean;

	constructor(
		public remote: Remote,
		public defaultBranch: string
	) {
		this.label = defaultBranch;
		this.description = `${remote.owner}/${remote.repositoryName}`;
	}
}
