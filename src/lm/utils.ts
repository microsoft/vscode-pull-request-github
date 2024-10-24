/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { commands } from '../common/executeCommands';
import { EXPERIMENTAL_USE_QUICK_CHAT, PR_SETTINGS_NAMESPACE } from '../common/settingKeys';

export function chatCommand(): typeof commands.QUICK_CHAT_OPEN | typeof commands.OPEN_CHAT {
	const useQuickChat = vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE).get<boolean>(EXPERIMENTAL_USE_QUICK_CHAT, false);
	if (useQuickChat) {
		return commands.QUICK_CHAT_OPEN;
	}
	return commands.OPEN_CHAT;
}