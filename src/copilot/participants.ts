/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';
import * as vscode from 'vscode';

export const chatParticipantHandler: vscode.ChatRequestHandler = async (
	request: vscode.ChatRequest,
	context: vscode.ChatContext,
	stream: vscode.ChatResponseStream
): Promise<void> => {
	if (request.command === 'issue') {
		stream.markdown(`The issue concerns incorrect behavior of the editor indentation in Python files.`);
	} else if (request.command === 'pr') {
		stream.markdown(`The PR is about adding a new feature to the editor.`);
	} else if (request.command === 'notification') {
		stream.markdown(`The notification is about adding a new feature to the editor.`);
	}
};
