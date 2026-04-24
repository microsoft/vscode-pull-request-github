/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { CopilotPRWatcher } from './copilotPrWatcher';

import { CredentialStore } from './credentials';
import { RepositoriesManager } from './repositoriesManager';
import { COPILOT_CLOUD_AGENT } from '../common/copilot';
import { Disposable } from '../common/lifecycle';
import { ITelemetry } from '../common/telemetry';
import { PrsTreeModel } from '../view/prsTreeModel';

export namespace SessionIdForPr {

	const prefix = 'pull-session-by-index';

	export function getResource(prNumber: number, sessionIndex: number): vscode.Uri {
		return vscode.Uri.from({
			scheme: COPILOT_CLOUD_AGENT, path: `/${prefix}-${prNumber}-${sessionIndex}`,
		});
	}

	export function parse(resource: vscode.Uri): { prNumber: number; sessionIndex: number } | undefined {
		const match = resource.path.match(new RegExp(`^/${prefix}-(\\d+)-(\\d+)$`));
		if (match) {
			return {
				prNumber: parseInt(match[1], 10),
				sessionIndex: parseInt(match[2], 10)
			};
		}
		return undefined;
	}
}

export class CopilotRemoteAgentManager extends Disposable {
	public static ID = 'CopilotRemoteAgentManager';
	private _isAssignable: boolean | undefined;

	constructor(
		private credentialStore: CredentialStore,
		public repositoriesManager: RepositoriesManager,
		private telemetry: ITelemetry,
		private context: vscode.ExtensionContext,
		private readonly prsTreeModel: PrsTreeModel,
	) {
		super();

		this._register(new CopilotPRWatcher(this.repositoriesManager, this.prsTreeModel));
	}
}