/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as buffer from 'buffer';
import * as vscode from 'vscode';
import { commands, contexts } from '../common/executeCommands';
import { Disposable } from '../common/lifecycle';
import { ITelemetry } from '../common/telemetry';
import { Schemes } from '../common/uri';
import { asPromise } from '../common/utils';
import { ConflictResolutionTreeView } from '../view/conflictResolution/conflictResolutionTreeView';
import { GitHubContentProvider } from '../view/gitHubContentProvider';
import { Conflict, ConflictResolutionModel } from './conflictResolutionModel';
import { GitHubRepository } from './githubRepository';

interface MergeEditorInputData { uri: vscode.Uri; title?: string; detail?: string; description?: string }
const ORIGINAL_FILE =
	`<<<<<<< HEAD:file.txt
A
=======
B
>>>>>>> fa7472b59e45e5b86c985a175aac33af7a8322a3:file.txt`;

class MergeOutputProvider extends Disposable implements vscode.FileSystemProvider {
	private _createTime: number = 0;
	private _modifiedTimes: Map<string, number> = new Map();
	private _mergedFiles: Map<string, Uint8Array> = new Map();
	get mergeResults(): Map<string, Uint8Array> {
		return this._mergedFiles;
	}
	private _onDidChangeFile = this._register(new vscode.EventEmitter<vscode.FileChangeEvent[]>());
	onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this._onDidChangeFile.event;

	constructor(private readonly _conflictResolutionModel: ConflictResolutionModel) {
		super();
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
			mtime: this._modifiedTimes.get(uri.path) ?? 0,
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
			// If the result file contains a conflict marker then the merge editor will automagically compute the merge result.
			this.updateFile(uri.path, buffer.Buffer.from(ORIGINAL_FILE));
		}
		return this._mergedFiles.get(uri.path)!;
	}
	writeFile(uri: vscode.Uri, content: Uint8Array, _options: { readonly create: boolean; readonly overwrite: boolean; }): void {
		this.updateFile(uri.path, content);
	}
	delete(_uri: vscode.Uri, _options: { readonly recursive: boolean; }): void {
		throw new Error('Method not implemented.');
	}
	rename(_oldUri: vscode.Uri, _newUri: vscode.Uri, _options: { readonly overwrite: boolean; }): void {
		throw new Error('Method not implemented.');
	}

	private _updateFile(file: string, contents: Uint8Array): void {
		this._mergedFiles.set(file, contents);
		this._modifiedTimes.set(file, new Date().getTime());
	}

	clear(): void {
		const fileEvents: vscode.FileChangeEvent[] = [];
		for (const file of this._mergedFiles.keys()) {
			fileEvents.push({ uri: vscode.Uri.from({ scheme: this._conflictResolutionModel.mergeScheme, path: file }), type: vscode.FileChangeType.Changed });
			this.updateFile(file, buffer.Buffer.from(ORIGINAL_FILE));
		}
		this._onDidChangeFile.fire(fileEvents);
	}

	override dispose(): void {
		super.dispose();
		this._mergedFiles.clear();
	}
}

export class ConflictResolutionCoordinator extends Disposable {
	private readonly _mergeOutputProvider: MergeOutputProvider;

	constructor(private readonly _telemetry: ITelemetry, private readonly _conflictResolutionModel: ConflictResolutionModel, private readonly _githubRepositories: GitHubRepository[]) {
		super();
		this._mergeOutputProvider = this._register(new MergeOutputProvider(this._conflictResolutionModel));
	}

	private async _openConflict(conflict: Conflict) {
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
	}

	private _register(): void {
		this._register(vscode.workspace.registerFileSystemProvider(Schemes.GithubPr, new GitHubContentProvider(this._githubRepositories), { isReadonly: true }));
		this._register(vscode.workspace.registerFileSystemProvider(this._conflictResolutionModel.mergeScheme, this._mergeOutputProvider));
		this._register(vscode.commands.registerCommand('pr.resolveConflict', (conflict: Conflict) => {
			return this.openConflict(conflict);
		}));
		this._register(vscode.commands.registerCommand('pr.acceptMerge', async (uri: vscode.Uri | unknown) => {
			return this.acceptMerge(uri);
		}));
		this._register(vscode.commands.registerCommand('pr.exitConflictResolutionMode', async () => {
			const exit = vscode.l10n.t('Exit and lose changes');
			const result = await vscode.window.showWarningMessage(vscode.l10n.t('Are you sure you want to exit conflict resolution mode? All changes will be lost.'), { modal: true }, exit);
			if (result === exit) {
				return this.exitConflictResolutionMode(false);
			}
		}));
		this._register(vscode.commands.registerCommand('pr.completeMerge', async () => {
			return this.exitConflictResolutionMode(true);
		}));
		this._register(new ConflictResolutionTreeView(this._conflictResolutionModel));
	}

	private async _acceptMerge(uri: vscode.Uri | unknown): Promise<void> {
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
		/* __GDPR__
			"pr.conflictResolution.start" : {}
		*/
		this._telemetry.sendTelemetryEvent('pr.conflictResolution.start');
		await commands.setContext(contexts.RESOLVING_CONFLICTS, true);
		this.register();
		this.openConflict(this._conflictResolutionModel.startingConflicts[0]);
	}

	private _onExitConflictResolutionMode = new vscode.EventEmitter<boolean>();
	async exitConflictResolutionMode(allConflictsResolved: boolean): Promise<void> {
		/* __GDPR__
			"pr.conflictResolution.exit" : {
				"allConflictsResolved" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" }
			}
		*/
		this._telemetry.sendTelemetryEvent('pr.conflictResolution.exit', { allConflictsResolved: allConflictsResolved.toString() });

		this._mergeOutputProvider.clear();
		await commands.setContext(contexts.RESOLVING_CONFLICTS, false);
		const tabsToClose: vscode.Tab[] = [];
		for (const group of vscode.window.tabGroups.all) {
			for (const tab of group.tabs) {
				if ((tab.input instanceof vscode.TabInputTextMerge) && (tab.input.result.scheme === this._conflictResolutionModel.mergeScheme)) {
					tabsToClose.push(tab);
				}
			}
		}
		await vscode.window.tabGroups.close(tabsToClose);
		this._onExitConflictResolutionMode.fire(allConflictsResolved);
		this.dispose();
	}

	async enterConflictResolutionAndWaitForExit(): Promise<boolean> {
		await this.enterConflictResolutionMode();
		return asPromise(this._onExitConflictResolutionMode.event);
	}
}