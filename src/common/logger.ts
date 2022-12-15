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
	private _outputChannel: vscode.OutputChannel;
	private _logLevel: LogLevel;
	private _disposable: vscode.Disposable;
	private _activePerfMarkers: Map<string, number> = new Map();

	constructor() {
		this._outputChannel = vscode.window.createOutputChannel('GitHub Pull Request');
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

	public appendLine(message: string, component?: string) {
		switch (this._logLevel) {
			case LogLevel.Off:
				return;
			case LogLevel.Debug:
				const hrtime = new Date().getTime() / 1000;
				const timeStamp = `${hrtime}s`;
				const info = component ? `${component}> ${message}` : `${message}`;
				this._outputChannel.appendLine(`[Debug ${timeStamp}] ${info}`);
				return;
			case LogLevel.Info:
			default:
				this._outputChannel.appendLine(`[Info] ` + (component ? `${component}> ${message}` : `${message}`));
				return;
		}
	}

	public debug(message: string, component: string) {
		if (this._logLevel === LogLevel.Debug) {
			this.appendLine(message, component);
		}
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
