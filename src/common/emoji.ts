/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Copied from https://github.com/microsoft/vscode/blob/af33df91a45498435bc47f16444d91db4582ce48/extensions/git/src/emoji.ts

'use strict';
import { TextDecoder } from 'util';
import { ExtensionContext, Uri, workspace } from 'vscode';

const emojiRegex = /:([-+_a-z0-9]+):/g;

let emojiMap: Record<string, string> | undefined;
let emojiMapPromise: Promise<void> | undefined;

export async function ensureEmojis(context: ExtensionContext) {
	if (emojiMap === undefined) {
		if (emojiMapPromise === undefined) {
			emojiMapPromise = loadEmojiMap(context);
		}
		await emojiMapPromise;
	}
}

async function loadEmojiMap(context: ExtensionContext) {
	const uri = (Uri as any).joinPath(context.extensionUri, 'resources', 'emojis.json');
	emojiMap = JSON.parse(new TextDecoder('utf8').decode(await workspace.fs.readFile(uri)));
}

export function emojify(message: string) {
	if (emojiMap === undefined) {
		return message;
	}

	return message.replace(emojiRegex, (s, code) => {
		return emojiMap?.[code] || s;
	});
}
