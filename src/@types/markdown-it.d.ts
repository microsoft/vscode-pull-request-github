/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

declare module 'markdown-it' {
	class MarkdownIt {
		constructor();
		renderInline(src: string, env?: unknown): string;
	}

	export default MarkdownIt;
}
