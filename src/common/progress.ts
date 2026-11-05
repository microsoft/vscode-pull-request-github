/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/**
 * A progress notification that can be closed while the user does something else, such as resolving conflicts
 * with other notifications, and that reopens on the next report.
 */
export class PausableProgressNotification {
	private _latestMessage: string | undefined;
	private _active: { progress?: vscode.Progress<{ message?: string }>; close(): void } | undefined;

	constructor(private readonly _title: string) { }

	report(message: string): void {
		this._latestMessage = message;
		if (this._active) {
			this._active.progress?.report({ message });
			return;
		}
		let close!: () => void;
		const closed = new Promise<void>(resolve => { close = resolve; });
		const active: PausableProgressNotification['_active'] = { close };
		this._active = active;
		void vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: this._title }, async progress => {
			// The notification can open after more reports, so it starts with the latest one.
			active.progress = progress;
			progress.report({ message: this._latestMessage });
			await closed;
		});
	}

	close(): void {
		this._active?.close();
		this._active = undefined;
	}
}
