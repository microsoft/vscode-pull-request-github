/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';

export const PR_TREE = 'PullRequestTree';

class Log {
	private _outputChannel: vscode.LogOutputChannel;
	private _disposable: vscode.Disposable;
	private _activePerfMarkers: Map<string, number> = new Map();

	constructor() {
		this._outputChannel = vscode.window.createOutputChannel('GitHub Pull Request', { log: true });
	}

	public startPerfMarker(marker: string) {
		const startTime = performance.now();
		this._outputChannel.appendLine(`PERF_MARKER> Start ${marker}`);
		this._activePerfMarkers.set(marker, startTime);
	}

	public endPerfMarker(marker: string) {
		const endTime = performance.now();
		this._outputChannel.appendLine(`PERF_MARKER> End ${marker}: ${endTime - this._activePerfMarkers.get(marker)!} ms`);
		this._activePerfMarkers.delete(marker);
	}

	private logString(message: any, component?: string): string {
		if (typeof message !== 'string') {
			if (message instanceof Error) {
				message = message.message;
			} else if ('toString' in message) {
				message = message.toString();
			} else {
				message = JSON.stringify(message);
			}
		}
		return component ? `${component}> ${message}` : message;
	}

	public trace(message: any, component: string) {
		this._outputChannel.trace(this.logString(message, component));
	}

	public debug(message: any, component: string) {
		this._outputChannel.debug(this.logString(message, component));
	}

	public appendLine(message: any, component?: string) {
		this._outputChannel.info(this.logString(message, component));
	}

	public warn(message: any, component?: string) {
		this._outputChannel.warn(this.logString(message, component));
	}

	public error(message: any, component?: string) {
		this._outputChannel.error(this.logString(message, component));
	}

	public dispose() {
		if (this._disposable) {
			this._disposable.dispose();
		}
	}
}

const Logger = new Log();
export default Logger;
