/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import Logger from './logger';

let tempState: TemporaryState | undefined;

export class TemporaryState extends vscode.Disposable {
	private readonly SUBPATH = 'temp';
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private _storageUri: vscode.Uri) {
		super(() => this.disposables.forEach(disposable => disposable.dispose()));
	}

	private get path(): vscode.Uri {
		return vscode.Uri.joinPath(this._storageUri, this.SUBPATH);
	}

	private addDisposable(disposable: vscode.Disposable) {
		if (this.disposables.length > 30) {
			const oldDisposable = this.disposables.shift();
			oldDisposable?.dispose();
		}
		this.disposables.push(disposable);
	}

	private async writeState(subpath: string, filename: string, contents: Uint8Array): Promise<vscode.Uri> {
		let filePath: vscode.Uri = this.path;
		const workspace = (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0)
			? vscode.workspace.workspaceFolders[0].name : undefined;

		if (workspace) {
			filePath = vscode.Uri.joinPath(filePath, workspace);
		}

		if (subpath) {
			filePath = vscode.Uri.joinPath(filePath, subpath);
		}
		await vscode.workspace.fs.createDirectory(filePath);
		const file = vscode.Uri.joinPath(filePath, filename);
		await vscode.workspace.fs.writeFile(file, contents);

		const dispose = {
			dispose: () => {
				return vscode.workspace.fs.delete(file, { recursive: true });
			}
		};
		this.addDisposable(dispose);
		return file;
	}

	static async init(context: vscode.ExtensionContext): Promise<vscode.Disposable | undefined> {
		if (context.globalStorageUri && !tempState) {
			tempState = new TemporaryState(context.globalStorageUri);
			try {
				await vscode.workspace.fs.delete(tempState.path, { recursive: true });
			} catch (e) {
				Logger.appendLine(`TemporaryState> Error in initialization: ${e.message}`);
			}
			try {
				await vscode.workspace.fs.createDirectory(tempState.path);
			} catch (e) {
				Logger.appendLine(`TemporaryState> Error in initialization: ${e.message}`);
			}
			context.subscriptions.push(tempState);
			return tempState;
		}
	}

	static async write(subpath: string, filename: string, contents: Uint8Array): Promise<vscode.Uri | undefined> {
		if (!tempState) {
			return;
		}

		return tempState.writeState(subpath, filename, contents);
	}
}