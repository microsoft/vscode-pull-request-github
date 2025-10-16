/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ensureEmojis } from '../common/emoji';
import { Schemes } from '../common/uri';

export class EmojiCompletionProvider implements vscode.CompletionItemProvider {
	private _emojiCompletions: vscode.CompletionItem[] = [];

	constructor(private _context: vscode.ExtensionContext) {
		void this.buildEmojiCompletions();
	}

	private async buildEmojiCompletions(): Promise<void> {
		const emojis = await ensureEmojis(this._context);

		for (const [name, emoji] of Object.entries(emojis)) {
			const completionItem = new vscode.CompletionItem({ label: emoji, description: `:${name}:` }, vscode.CompletionItemKind.Text);
			completionItem.filterText = `:${name}:`;
			completionItem.sortText = name;
			this._emojiCompletions.push(completionItem);
		}
	}

	provideCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
		_token: vscode.CancellationToken,
		_context: vscode.CompletionContext
	): vscode.ProviderResult<vscode.CompletionItem[] | vscode.CompletionList> {
		// Only provide completions for comment documents
		if (document.uri.scheme !== Schemes.Comment) {
			return [];
		}

		let wordRange = document.getWordRangeAtPosition(position);
		let wordAtPos = wordRange ? document.getText(wordRange) : undefined;
		if (!wordRange || wordAtPos?.charAt(0) !== ':') {
			const start = wordRange?.start ?? position;
			const testWordRange = new vscode.Range(start.translate(undefined, start.character ? -1 : 0), position);
			const testWord = document.getText(testWordRange);
			if (testWord.charAt(0) === ':') {
				wordRange = testWordRange;
				wordAtPos = testWord;
			}
		}

		// Only provide completions if we're in an emoji context (don't clutter Ctrl+Space results)
		if (!wordRange || !wordAtPos) {
			return [];
		}

		// Ensure the : comes after a space or start of line
		const colonPosition = wordRange.start;
		if (colonPosition.character > 0) {
			const charBeforeColon = document.getText(new vscode.Range(
				colonPosition.translate(0, -1),
				colonPosition
			));
			// If the character before : is not whitespace, don't show completions
			if (!/\s/.test(charBeforeColon)) {
				return [];
			}
		}

		// Update the range on cached items directly
		for (const item of this._emojiCompletions) {
			item.range = wordRange;
		}

		return new vscode.CompletionList(this._emojiCompletions, false);
	}
}
