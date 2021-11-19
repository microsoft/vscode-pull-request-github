/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// https://github.com/microsoft/vscode/blob/d33c0621bc049594f93830b20bf0d8e2ff2f6a40/src/vs/base/common/htmlContent.ts#L105-L106
export function escapeMarkdownSyntaxTokens(text: string): string {
	// escape markdown syntax tokens: http://daringfireball.net/projects/markdown/syntax#backslash
	return text.replace(/[\\`*_{}[\]()#+\-!]/g, '\\$&');
}