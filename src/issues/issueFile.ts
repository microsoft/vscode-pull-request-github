/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { FolderRepositoryManager, PullRequestDefaults } from '../github/folderRepositoryManager';
import { IProject } from '../github/interface';
import { RepositoriesManager } from '../github/repositoriesManager';

export const NEW_ISSUE_SCHEME = 'newIssue';
export const NEW_ISSUE_FILE = 'NewIssue.md';
export const ASSIGNEES = vscode.l10n.t('Assignees:');
export const LABELS = vscode.l10n.t('Labels:');
export const MILESTONE = vscode.l10n.t('Milestone:');
export const PROJECTS = vscode.l10n.t('Projects:');

const NEW_ISSUE_CACHE = 'newIssue.cache';

export function extractIssueOriginFromQuery(uri: vscode.Uri): vscode.Uri | undefined {
	const query = JSON.parse(uri.query);
	if (query.origin) {
		return vscode.Uri.parse(query.origin);
	}
}

export class IssueFileSystemProvider implements vscode.FileSystemProvider {
	private content: Uint8Array | undefined;
	private createTime: number = 0;
	private modifiedTime: number = 0;
	private _onDidChangeFile: vscode.EventEmitter<vscode.FileChangeEvent[]> = new vscode.EventEmitter<
		vscode.FileChangeEvent[]
	>();

	constructor(private readonly cache: NewIssueCache) { }
	onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this._onDidChangeFile.event;
	watch(_uri: vscode.Uri, _options: { recursive: boolean; excludes: string[] }): vscode.Disposable {
		const disposable = this.onDidChangeFile(e => {
			if (e.length === 0 && e[0].type === vscode.FileChangeType.Deleted) {
				disposable.dispose();
			}
		});
		return disposable;
	}
	stat(_uri: vscode.Uri): vscode.FileStat {
		return {
			type: vscode.FileType.File,
			ctime: this.createTime,
			mtime: this.modifiedTime,
			size: this.content?.length ?? 0,
		};
	}
	readDirectory(_uri: vscode.Uri): [string, vscode.FileType][] | Thenable<[string, vscode.FileType][]> {
		return [];
	}
	createDirectory(_uri: vscode.Uri): void { }
	readFile(_uri: vscode.Uri): Uint8Array | Thenable<Uint8Array> {
		return this.content ?? new Uint8Array(0);
	}
	writeFile(
		uri: vscode.Uri,
		content: Uint8Array,
		_options: { create: boolean; overwrite: boolean } = { create: false, overwrite: false },
	): void | Thenable<void> {
		const oldContent = this.content;
		this.content = content;
		if (oldContent === undefined) {
			this.createTime = new Date().getTime();
			this._onDidChangeFile.fire([{ uri: uri, type: vscode.FileChangeType.Created }]);
		} else {
			this.modifiedTime = new Date().getTime();
			this._onDidChangeFile.fire([{ uri: uri, type: vscode.FileChangeType.Changed }]);
		}
		this.cache.cache(content);
	}
	delete(uri: vscode.Uri, _options: { recursive: boolean }): void | Thenable<void> {
		this.content = undefined;
		this.createTime = 0;
		this.modifiedTime = 0;
		this._onDidChangeFile.fire([{ uri: uri, type: vscode.FileChangeType.Deleted }]);
	}

	rename(_oldUri: vscode.Uri, _newUri: vscode.Uri, _options: { overwrite: boolean }): void | Thenable<void> { }
}

export class NewIssueFileCompletionProvider implements vscode.CompletionItemProvider {
	constructor(private manager: RepositoriesManager) { }

	async provideCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
		_token: vscode.CancellationToken,
		_context: vscode.CompletionContext,
	): Promise<vscode.CompletionItem[]> {
		const line = document.lineAt(position.line).text;
		if (!line.startsWith(LABELS) && !line.startsWith(MILESTONE) && !line.startsWith(PROJECTS)) {
			return [];
		}
		const originFile = extractIssueOriginFromQuery(document.uri);
		if (!originFile) {
			return [];
		}
		const folderManager = this.manager.getManagerForFile(originFile);
		if (!folderManager) {
			return [];
		}
		const defaults = await folderManager.getPullRequestDefaults();

		if (line.startsWith(LABELS)) {
			return this.provideLabelCompletionItems(folderManager, defaults);
		} else if (line.startsWith(MILESTONE)) {
			return this.provideMilestoneCompletionItems(folderManager);
		} else if (line.startsWith(PROJECTS)) {
			return this.provideProjectCompletionItems(folderManager);
		} else {
			return [];
		}
	}

	private async provideLabelCompletionItems(folderManager: FolderRepositoryManager, defaults: PullRequestDefaults): Promise<vscode.CompletionItem[]> {
		const labels = await folderManager.getLabels(undefined, defaults);
		return labels.map(label => {
			const item = new vscode.CompletionItem(label.name, vscode.CompletionItemKind.Color);
			item.documentation = `#${label.color}`;
			item.commitCharacters = [' ', ','];
			return item;
		});
	}

	private async provideMilestoneCompletionItems(folderManager: FolderRepositoryManager): Promise<vscode.CompletionItem[]> {
		const milestones = await (await folderManager.getPullRequestDefaultRepo())?.getMilestones() ?? [];
		return milestones.map(milestone => {
			const item = new vscode.CompletionItem(milestone.title, vscode.CompletionItemKind.Event);
			item.commitCharacters = [' ', ','];
			return item;
		});
	}

	private async provideProjectCompletionItems(folderManager: FolderRepositoryManager): Promise<vscode.CompletionItem[]> {
		const repo = await folderManager.getPullRequestDefaultRepo();
		const projects = await folderManager.getAllProjects(repo) ?? [];
		return projects.map(project => {
			const item = new vscode.CompletionItem(project.title, vscode.CompletionItemKind.Event);
			item.commitCharacters = [' ', ','];
			return item;
		});
	}
}

export class NewIssueCache {
	constructor(private readonly context: vscode.ExtensionContext) {
		this.clear();
	}

	public cache(issueFileContent: Uint8Array) {
		this.context.workspaceState.update(NEW_ISSUE_CACHE, issueFileContent);
	}

	public clear() {
		this.context.workspaceState.update(NEW_ISSUE_CACHE, undefined);
	}

	public get(): string | undefined {
		const content = this.context.workspaceState.get<Uint8Array | undefined>(NEW_ISSUE_CACHE);
		if (content) {
			return new TextDecoder().decode(content);
		}
	}
}

export async function extractMetadataFromFile(repositoriesManager: RepositoriesManager): Promise<{ labels: string[] | undefined, milestone: number | undefined, projects: IProject[] | undefined, assignees: string[] | undefined, title: string, body: string | undefined, originUri: vscode.Uri } | undefined> {
	let text: string;
	if (
		!vscode.window.activeTextEditor ||
		vscode.window.activeTextEditor.document.uri.scheme !== NEW_ISSUE_SCHEME
	) {
		return;
	}
	const originUri = extractIssueOriginFromQuery(vscode.window.activeTextEditor.document.uri);
	if (!originUri) {
		return;
	}
	const folderManager = repositoriesManager.getManagerForFile(originUri);
	if (!folderManager) {
		return;
	}
	const repo = await folderManager.getPullRequestDefaultRepo();
	text = vscode.window.activeTextEditor.document.getText();
	const indexOfEmptyLineWindows = text.indexOf('\r\n\r\n');
	const indexOfEmptyLineOther = text.indexOf('\n\n');
	let indexOfEmptyLine: number;
	if (indexOfEmptyLineWindows < 0 && indexOfEmptyLineOther < 0) {
		return;
	} else {
		if (indexOfEmptyLineWindows < 0) {
			indexOfEmptyLine = indexOfEmptyLineOther;
		} else if (indexOfEmptyLineOther < 0) {
			indexOfEmptyLine = indexOfEmptyLineWindows;
		} else {
			indexOfEmptyLine = Math.min(indexOfEmptyLineWindows, indexOfEmptyLineOther);
		}
	}
	const title = text.substring(0, indexOfEmptyLine);
	if (!title) {
		return;
	}
	let assignees: string[] | undefined;
	text = text.substring(indexOfEmptyLine + 2).trim();
	if (text.startsWith(ASSIGNEES)) {
		const lines = text.split(/\r\n|\n/, 1);
		if (lines.length === 1) {
			assignees = lines[0]
				.substring(ASSIGNEES.length)
				.split(',')
				.map(value => {
					value = value.trim();
					if (value.startsWith('@')) {
						value = value.substring(1);
					}
					return value;
				});
			text = text.substring(lines[0].length).trim();
		}
	}
	let labels: string[] | undefined;
	if (text.startsWith(LABELS)) {
		const lines = text.split(/\r\n|\n/, 1);
		if (lines.length === 1) {
			labels = lines[0]
				.substring(LABELS.length)
				.split(',')
				.map(value => value.trim())
				.filter(label => label);
			text = text.substring(lines[0].length).trim();
		}
	}
	let milestone: number | undefined;
	if (text.startsWith(MILESTONE)) {
		const lines = text.split(/\r\n|\n/, 1);
		if (lines.length === 1) {
			const milestoneTitle = lines[0].substring(MILESTONE.length).trim();
			if (milestoneTitle) {
				const repoMilestones = await repo.getMilestones();
				milestone = repoMilestones?.find(milestone => milestone.title === milestoneTitle)?.number;
			}
			text = text.substring(lines[0].length).trim();
		}
	}
	let projects: IProject[] | undefined;
	if (text.startsWith(PROJECTS)) {
		const lines = text.split(/\r\n|\n/, 1);
		if (lines.length === 1) {
			const repoProjects = await folderManager.getAllProjects(repo);
			projects = lines[0].substring(PROJECTS.length)
				.split(',')
				.map(value => {
					value = value.trim();
					return repoProjects.find(project => project.title === value);
				})
				.filter<IProject>((project): project is IProject => !!project);

			text = text.substring(lines[0].length).trim();
		}
	}
	const body = text ?? '';
	return { labels, milestone, projects, assignees, title, body, originUri };
}
