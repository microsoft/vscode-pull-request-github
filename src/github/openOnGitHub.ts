/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { openWithDefaultExternalOpener } from '../common/externalUri';
import { ITelemetry } from '../common/telemetry';

export type GitHubItemKind = 'issue' | 'pullRequest';

export function openIssueOrPullRequestOnGitHub(
	uri: vscode.Uri,
	kind: GitHubItemKind,
	telemetry: ITelemetry,
): Thenable<boolean> {
	if (kind === 'pullRequest') {
		/* __GDPR__
			"pr.openInGitHub" : {}
		*/
		telemetry.sendTelemetryEvent('pr.openInGitHub');
	} else {
		/* __GDPR__
			"issue.openOnGitHub" : {}
		*/
		telemetry.sendTelemetryEvent('issue.openOnGitHub');
	}
	return openWithDefaultExternalOpener(uri);
}
