/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import { ISessionState } from "../../common/sessionState";

export class MockSessionState implements ISessionState {
	commentsExpandState: true;
	onDidChangeCommentsExpandState = new vscode.EventEmitter<boolean>().event;
}