/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

export class ProgressHelper {
	private _progress: Promise<void> = Promise.resolve();
	private _endProgress: vscode.EventEmitter<void> = new vscode.EventEmitter();

	get progress(): Promise<void> {
		return this._progress;
	}
	startProgress() {
		this.endProgress();
		this._progress = new Promise(resolve => {
			const disposable = this._endProgress.event(() => {
				disposable.dispose();
				resolve();
			});
		});
	}

	endProgress() {
		this._endProgress.fire();
	}
}