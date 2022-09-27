/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';

const enum LogLevel {
	Info,
	Debug,
	Off,
}

const SETTINGS_NAMESPACE = 'githubPullRequests';
const LOG_LEVEL_SETTING = 'logLevel';
export const PR_TREE = 'PullRequestTree';

class Log {
	private _outputChannel: vscode.LogOutputChannel;
	private _logLevel: LogLevel;
	private _disposable: vscode.Disposable;
	private _activePerfMarkers: Map<string, number> = new Map();

	constructor() {
		this._outputChannel = vscode.window.createOutputChannel('GitHub Pull Request', { log: true });
		this._disposable = vscode.workspace.onDidChangeConfiguration(() => {
			this.getLogLevel();
		});
		this.getLogLevel();
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

	private logString(message: string, component?: string) {
		return component ? `${component}> ${message}` : message;
	}

	public trace(message: string, component: string) {
		this._outputChannel.debug(this.logString(message, component));
	}

	public debug(message: string, component: string) {
		this._outputChannel.debug(this.logString(message, component));
	}

	public appendLine(message: string, component?: string) {
		this._outputChannel.info(this.logString(message, component));
	}

	public warn(message: string, component?: string) {
		this._outputChannel.debug(this.logString(message, component));
	}

	public error(message: string, component?: string) {
		this._outputChannel.debug(this.logString(message, component));
	}

	public dispose() {
		if (this._disposable) {
			this._disposable.dispose();
		}
	}

	private getLogLevel() {
		const logLevel = vscode.workspace.getConfiguration(SETTINGS_NAMESPACE).get<string>(LOG_LEVEL_SETTING);
		switch (logLevel) {
			case 'debug':
				this._logLevel = LogLevel.Debug;
				break;
			case 'off':
				this._logLevel = LogLevel.Off;
				break;
			case 'info':
			default:
				this._logLevel = LogLevel.Info;
				break;
		}
	}
}

const Logger = new Log();
export default Logger;
