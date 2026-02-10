/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import { RepoToolBase } from './toolsUtils';

interface FetchLabelsToolParameters {
	repo?: {
		owner?: string;
		name?: string;
	};
}

export interface FetchLabelsResult {
	owner: string;
	repo: string;
	labels: {
		name: string;
		color: string;
		description?: string;
	}[];
}

export class FetchLabelsTool extends RepoToolBase<FetchLabelsToolParameters> {
	public static readonly toolId = 'github-pull-request_labels_fetch';

	async invoke(options: vscode.LanguageModelToolInvocationOptions<FetchLabelsToolParameters>, _token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult> {
		const { owner, name, folderManager } = await this.getRepoInfo({ owner: options.input.repo?.owner, name: options.input.repo?.name });
		const labels = await folderManager.getLabels(undefined, { owner, repo: name });
		const result: FetchLabelsResult = {
			owner,
			repo: name,
			labels: labels.map(label => ({
				name: label.name,
				color: label.color,
				description: label.description
			}))
		};
		return new vscode.LanguageModelToolResult([
			new vscode.LanguageModelTextPart(JSON.stringify(result)),
			new vscode.LanguageModelTextPart('Above is a stringified JSON representation of the labels for the repository.')
		]);
	}

	async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<FetchLabelsToolParameters>): Promise<vscode.PreparedToolInvocation> {
		const { owner, name } = await this.getRepoInfo({ owner: options.input.repo?.owner, name: options.input.repo?.name });
		const url = (owner && name) ? `https://github.com/${owner}/${name}/labels` : undefined;
		const message = url
			? new vscode.MarkdownString(vscode.l10n.t('Fetching labels from [{0}/{1}]({2})', owner, name, url))
			: vscode.l10n.t('Fetching labels from GitHub');
		return {
			invocationMessage: message,
		};
	}
}
