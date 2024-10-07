/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';
import * as vscode from 'vscode';
import { handleIssueCommand } from './commandHandlers';

export const chatParticipantHandler: vscode.ChatRequestHandler = async (
	request: vscode.ChatRequest,
	context: vscode.ChatContext,
	stream: vscode.ChatResponseStream,
	token: vscode.CancellationToken
): Promise<void> => {
	if (request.command === 'issue') {
		await handleIssueCommand(request, context, stream, token);
	} else if (request.command === 'notification') {
		stream.markdown(`You did a request for notification search`);
	}
};
