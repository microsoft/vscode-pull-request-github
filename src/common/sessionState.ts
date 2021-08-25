/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { SETTINGS_NAMESPACE } from '../github/folderRepositoryManager';
import { COMMENT_EXPAND_STATE_EXPAND_VALUE, COMMENT_EXPAND_STATE_SETTING } from '../github/utils';

export interface ISessionState {
	onDidChangeCommentsExpandState: vscode.Event<boolean>;
	commentsExpandState: boolean;
}

export class SessionState implements ISessionState {
	private _commentsExpandState: boolean;
	private _onDidChangeCommentsExpandState: vscode.EventEmitter<boolean> = new vscode.EventEmitter();
	public onDidChangeCommentsExpandState = this._onDidChangeCommentsExpandState.event;
	get commentsExpandState(): boolean {
		return this._commentsExpandState;
	}
	set commentsExpandState(expand: boolean) {
		this._commentsExpandState = expand;
		this._onDidChangeCommentsExpandState.fire(this._commentsExpandState);
	}

	constructor(context: vscode.ExtensionContext) {
		const config = vscode.workspace.getConfiguration(SETTINGS_NAMESPACE)?.get(COMMENT_EXPAND_STATE_SETTING);
		this._commentsExpandState = config === COMMENT_EXPAND_STATE_EXPAND_VALUE;
		context.subscriptions.push(
			vscode.workspace.onDidChangeConfiguration(event => {
				if (event.affectsConfiguration(`${SETTINGS_NAMESPACE}.${COMMENT_EXPAND_STATE_SETTING}`)) {
					const config = vscode.workspace.getConfiguration(SETTINGS_NAMESPACE)?.get(COMMENT_EXPAND_STATE_SETTING);
					this.commentsExpandState = config === COMMENT_EXPAND_STATE_EXPAND_VALUE;
				}
			}));
	}
}