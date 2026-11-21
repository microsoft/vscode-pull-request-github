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
		context: vscode.CompletionContext
	): vscode.ProviderResult<vscode.CompletionItem[] | vscode.CompletionList> {
		// Only provide completions for comment documents
		if (document.uri.scheme !== Schemes.Comment) {
			return [];
		}

		const word = document.getWordRangeAtPosition(position, /:([-+_a-z0-9]+:?)?/i);
		if (!word) {
			return [];
		}

		// If invoked by trigger charcter, ignore if this is the start of an emoji (single ':') and there is no preceding space
		if (context.triggerKind === vscode.CompletionTriggerKind.TriggerCharacter) {
			if (word.end.character - word.start.character === 1 && word.start.character > 0) {
				const charBefore = document.getText(new vscode.Range(word.start.translate(0, -1), word.start));
				if (!/\s/.test(charBefore)) {
					return [];
				}
			}
		}

		// Update the range on cached items directly
		for (const item of this._emojiCompletions) {
			item.range = word;
		}

		return new vscode.CompletionList(this._emojiCompletions, false);
	}
}
