/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IssueTemplate } from './util';

/**
 * Reads the metadata of an issue template.
 *
 * Kept free of `vscode` imports so that it can be unit tested.
 */
export function getIssueTemplateData(template: string): IssueTemplate {
	const title = template.match(/title:\s*(.*)/)?.[1]?.replace(/^["']|["']$/g, '');
	const name = template.match(/name:\s*(.*)/)?.[1]?.replace(/^["']|["']$/g, '');
	const about = template.match(/about:\s*(.*)/)?.[1]?.replace(/^["']|["']$/g, '');
	const body = template.match(/---([\s\S]*)---([\s\S]*)/)?.[2];
	return { title, name, about, body };
}
