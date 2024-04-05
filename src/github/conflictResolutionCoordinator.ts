/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { commands, contexts } from '../common/executeCommands';
import { Schemes } from '../common/uri';
import { asPromise } from '../common/utils';
import { ConflictResolutionTreeView } from '../view/conflictResolution/conflictResolutionTreeView';
import { GitHubContentProvider } from '../view/gitHubContentProvider';
import { Conflict, ConflictResolutionModel } from './conflictResolutionModel';
import { GitHubRepository } from './githubRepository';

interface MergeEditorInputData { uri: vscode.Uri; title?: string; detail?: string; description?: string }

class MergeOutputProvider implements vscode.FileSystemProvider {
	private _createTime: number = 0;
	private _modifiedTime: number = 0;
	private _mergedFiles: Map<string, Uint8Array> = new Map();
	get mergeResults(): Map<string, Uint8Array> {
		return this._mergedFiles;
	}
	onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = new vscode.EventEmitter<vscode.FileChangeEvent[]>().event;
	constructor(private readonly _conflictResolutionModel: ConflictResolutionModel) {
		this._createTime = new Date().getTime();
	}
	watch(_uri: vscode.Uri, _options: { readonly recursive: boolean; readonly excludes: readonly string[]; }): vscode.Disposable {
		// no-op because no one else can modify this file.
		return {
			dispose: () => { }
		};
	}
	stat(uri: vscode.Uri): vscode.FileStat {
		return {
			type: vscode.FileType.File,
			ctime: this._createTime,
			mtime: this._modifiedTime,
			size: this._mergedFiles.get(uri.path)?.length ?? 0,
		};
	}
	readDirectory(_uri: vscode.Uri): [string, vscode.FileType][] {
		throw new Error('Method not implemented.');
	}
	createDirectory(_uri: vscode.Uri): void {
		throw new Error('Method not implemented.');
	}
	async readFile(uri: vscode.Uri): Promise<Uint8Array> {
		if (!this._mergedFiles.has(uri.path)) {
			const original = this._conflictResolutionModel.mergeBaseUri({ prHeadFilePath: uri.path });
			const content = await vscode.workspace.fs.readFile(original);
			this._mergedFiles.set(uri.path, content);
		}
		return this._mergedFiles.get(uri.path)!;
	}
	writeFile(uri: vscode.Uri, content: Uint8Array, _options: { readonly create: boolean; readonly overwrite: boolean; }): void {
		this._modifiedTime = new Date().getTime();
		this._mergedFiles.set(uri.path, content);
	}
	delete(_uri: vscode.Uri, _options: { readonly recursive: boolean; }): void {
		throw new Error('Method not implemented.');
	}
	rename(_oldUri: vscode.Uri, _newUri: vscode.Uri, _options: { readonly overwrite: boolean; }): void {
		throw new Error('Method not implemented.');
	}
}

export class ConflictResolutionCoordinator {
	private _disposables: vscode.Disposable[] = [];
	private _mergeOutputProvider: MergeOutputProvider;

	constructor(private readonly _conflictResolutionModel: ConflictResolutionModel, private readonly _githubRepositories: GitHubRepository[]) {
		this._mergeOutputProvider = new MergeOutputProvider(this._conflictResolutionModel);
	}

	private register(): void {
		this._disposables.push(vscode.workspace.registerFileSystemProvider(Schemes.GithubPr, new GitHubContentProvider(this._githubRepositories), { isReadonly: true }));
		this._disposables.push(vscode.workspace.registerFileSystemProvider(Schemes.MergeOutput, this._mergeOutputProvider));
		this._disposables.push(vscode.commands.registerCommand('pr.resolveConflict', async (conflict: Conflict) => {
			const prHeadUri = this._conflictResolutionModel.prHeadUri(conflict);
			const baseUri = this._conflictResolutionModel.baseUri(conflict);

			const prHead: MergeEditorInputData = { uri: prHeadUri, title: vscode.l10n.t('Pull Request Head') };
			const base: MergeEditorInputData = { uri: baseUri, title: vscode.l10n.t('{0} Branch', this._conflictResolutionModel.prBaseBranchName) };

			const mergeBaseUri: vscode.Uri = this._conflictResolutionModel.mergeBaseUri(conflict);
			const mergeOutput = this._conflictResolutionModel.mergeOutputUri(conflict);
			const options = {
				base: mergeBaseUri,
				input1: prHead,
				input2: base,
				output: mergeOutput
			};
			await commands.executeCommand(
				'_open.mergeEditor',
				options
			);
		}));
		this._disposables.push(vscode.commands.registerCommand('pr.acceptMerge', async (uri: vscode.Uri | unknown) => {
			return this.acceptMerge(uri);
		}));
		this._disposables.push(vscode.commands.registerCommand('pr.exitConflictResolutionMode', async () => {
			const exit = vscode.l10n.t('Exit and lose changes');
			const result = await vscode.window.showWarningMessage(vscode.l10n.t('Are you sure you want to exit conflict resolution mode? All changes will be lost.'), { modal: true }, exit);
			if (result === exit) {
				return this.exitConflictResolutionMode(false);
			}
		}));
		this._disposables.push(vscode.commands.registerCommand('pr.completeMerge', async () => {
			return this.exitConflictResolutionMode(true);
		}));
		this._disposables.push(new ConflictResolutionTreeView(this._conflictResolutionModel));
	}

	private async acceptMerge(uri: vscode.Uri | unknown): Promise<void> {
		if (!(uri instanceof vscode.Uri)) {
			return;
		}
		const { activeTab } = vscode.window.tabGroups.activeTabGroup;
		if (!activeTab || !(activeTab.input instanceof vscode.TabInputTextMerge)) {
			return;
		}

		const result = await commands.executeCommand('mergeEditor.acceptMerge') as { successful: boolean };
		if (result.successful) {
			const contents = new TextDecoder().decode(this._mergeOutputProvider.mergeResults.get(uri.path)!);
			this._conflictResolutionModel.addResolution(uri.path.substring(1), contents);
		}
	}

	async enterConflictResolutionMode(): Promise<void> {
		await commands.setContext(contexts.RESOLVING_CONFLICTS, true);
		this.register();
	}

	private _onExitConflictResolutionMode = new vscode.EventEmitter<boolean>();
	async exitConflictResolutionMode(allConflictsResolved: boolean): Promise<void> {
		await commands.setContext(contexts.RESOLVING_CONFLICTS, false);
		this._onExitConflictResolutionMode.fire(allConflictsResolved);
		this.dispose();
	}

	async enterConflictResolutionAndWaitForExit(): Promise<boolean> {
		await this.enterConflictResolutionMode();
		return asPromise(this._onExitConflictResolutionMode.event);
	}

	dispose(): void {
		this._disposables.forEach(d => d.dispose());
	}
}