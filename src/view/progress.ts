/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

export class ProgressHelper {
	private _progress: Promise<void> = Promise.resolve();
	private readonly _endProgress = new vscode.EventEmitter<void>();

	get progress(): Promise<void> {
		return this._progress;
	}

	private startProgress(): void {
		this.endProgress();
		this._progress = new Promise(resolve => {
			const disposable = this._endProgress.event(() => {
				disposable.dispose();
				resolve();
			});
		});
	}

	private endProgress(): void {
		this._endProgress.fire();
	}

	async run(task: () => Promise<void>): Promise<void> {
		this.startProgress();
		try {
			await task();
		} finally {
			this.endProgress();
		}
	}
}