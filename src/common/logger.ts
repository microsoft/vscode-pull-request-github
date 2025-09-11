/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import { Disposable } from './lifecycle';

export const PR_TREE = 'PullRequestTree';

interface Stringish {
	toString: () => string;
}

class Log extends Disposable {
	private readonly _outputChannel: vscode.LogOutputChannel;
	private readonly _activePerfMarkers: Map<string, number> = new Map();

	constructor() {
		super();
		this._outputChannel = this._register(vscode.window.createOutputChannel('GitHub Pull Request', { log: true }));
	}

	public startPerfMarker(marker: string) {
		const startTime = performance.now();
		this._outputChannel.appendLine(`[PERF_MARKER] Start ${marker}`);
		this._activePerfMarkers.set(marker, startTime);
	}

	public endPerfMarker(marker: string) {
		const endTime = performance.now();
		this._outputChannel.appendLine(`[PERF_MARKER] End ${marker}: ${endTime - this._activePerfMarkers.get(marker)!} ms`);
		this._activePerfMarkers.delete(marker);
	}

	private _logString(message: string | Error | Stringish | Object, component?: string): string {
		let logMessage: string;
		if (typeof message !== 'string') {
			const asString = message as Partial<Stringish>;
			if (message instanceof Error) {
				logMessage = message.message;
			} else if (asString.toString) {
				logMessage = asString.toString();
			} else {
				logMessage = JSON.stringify(message);
			}
		} else {
			logMessage = message;
		}
		return component ? `[${component}] ${logMessage}` : logMessage;
	}

	public trace(message: string | Error | Stringish | Object, component: string) {
		this._outputChannel.trace(this._logString(message, component));
	}

	public debug(message: string | Error | Stringish | Object, component: string) {
		this._outputChannel.debug(this._logString(message, component));
	}

	public appendLine(message: string | Error | Stringish | Object, component: string) {
		this._outputChannel.info(this._logString(message, component));
	}

	public warn(message: string | Error | Stringish | Object, component?: string) {
		this._outputChannel.warn(this._logString(message, component));
	}

	public error(message: string | Error | Stringish | Object, component: string) {
		this._outputChannel.error(this._logString(message, component));
	}
}

const Logger = new Log();
export default Logger;
