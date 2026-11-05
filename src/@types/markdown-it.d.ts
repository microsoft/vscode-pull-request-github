/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

declare module 'markdown-it' {
	export interface Token {
		type: string;
		content: string;
		children: Token[] | null;
	}

	export interface Renderer {
		renderInline(tokens: Token[], options: object, env: object): string;
	}

	class MarkdownIt {
		constructor();
		readonly options: object;
		readonly renderer: Renderer;
		parseInline(src: string, env: object): Token[];
	}

	export default MarkdownIt;
}
