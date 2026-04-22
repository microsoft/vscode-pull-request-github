/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

import { COPILOT_CLOUD_AGENT } from '../common/copilot';

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