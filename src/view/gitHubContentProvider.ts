/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as buffer from 'buffer';
import * as vscode from 'vscode';
import { fromGitHubURI, GitHubUriParams } from '../common/uri';
import { FolderRepositoryManager } from '../github/folderRepositoryManager';
import { GitHubRepository } from '../github/githubRepository';

export async function getGitHubFileContent(gitHubRepository: GitHubRepository, fileName: string, branch: string): Promise<Uint8Array> {
	const { octokit, remote } = await gitHubRepository.ensure();
	let fileContent: { data: { content: string; encoding: string; sha: string } } = (await octokit.call(octokit.api.repos.getContent,
		{
			owner: remote.owner,
			repo: remote.repositoryName,
			path: fileName,
			ref: branch,
		},
	)) as any;
	let contents = fileContent.data.content ?? '';

	// Empty contents and 'none' encoding indcates that the file has been truncated and we should get the blob.
	if (contents === '' && fileContent.data.encoding === 'none') {
		const fileSha = fileContent.data.sha;
		fileContent = await octokit.call(octokit.api.git.getBlob, {
			owner: remote.owner,
			repo: remote.repositoryName,
			file_sha: fileSha,
		});
		contents = fileContent.data.content;
	}

	const buff = buffer.Buffer.from(contents, (fileContent.data as any).encoding);
	return buff;
}

async function getGitFileContent(folderRepoManager: FolderRepositoryManager, fileName: string, branch: string, isEmpty: boolean): Promise<Uint8Array> {
	let content = '';
	if (!isEmpty) {
		content = await folderRepoManager.repository.show(branch, vscode.Uri.joinPath(folderRepoManager.repository.rootUri, fileName).fsPath);
	}
	return new TextEncoder().encode(content);
}

interface FileData {
	file: Uint8Array;
	modified: boolean;
}

export abstract class ChangesContentProvider implements Partial<vscode.FileSystemProvider> {
	protected _onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
	onDidChangeFile = this._onDidChangeFile.event;

	public readonly changedFiles = new Map<string, FileData>(); // uri key

	protected _readonlyBranches: string[] = [];
	set readonlyBranches(value: string[]) {
		this._readonlyBranches = value;
	}

	hasChanges(): boolean {
		return [...this.changedFiles.values()].some(file => file.modified);
	}

	abstract applyChanges(commitMessage: string, branch?: string): Promise<boolean>;

	async tryReadFile(uri: vscode.Uri, asParams: GitHubUriParams | undefined): Promise<Uint8Array | undefined> {
		if (!this.changedFiles.has(uri.toString())) {
			if (!asParams || asParams.isEmpty) {
				this.changedFiles.set(uri.toString(), { file: new TextEncoder().encode(''), modified: false });

			}
		}
		return this.changedFiles.get(uri.toString())?.file;
	}

	writeFile(uri: vscode.Uri, content: Uint8Array, _options: { create: boolean; overwrite: boolean; }): void {
		this.changedFiles.set(uri.toString(), { file: content, modified: true });
	}

	watch(_uri: vscode.Uri, _options: { recursive: boolean; excludes: string[]; }): vscode.Disposable {
		/** no op */
		return { dispose: () => { } };
	}

	stat(uri: any): vscode.FileStat {
		const params = fromGitHubURI(uri);

		return {
			type: vscode.FileType.File,
			ctime: 0,
			mtime: 0,
			size: 0,
			permissions: (params?.branch && this._readonlyBranches.includes(params.branch)) ? vscode.FilePermission.Readonly : undefined
		};
	}

	readDirectory(_uri: vscode.Uri): [string, vscode.FileType][] {
		return [];
	}

	createDirectory(_uri: vscode.Uri): void {
		/** no op */
	}

	delete(_uri: vscode.Uri, _options: { recursive: boolean; }): void {
		/** no op */
	}

	rename(_oldUri: vscode.Uri, _newUri: vscode.Uri, _options: { overwrite: boolean; }): void {
		/** no op */
	}
}


/**
 * Provides file contents for documents with githubpr scheme. Contents are fetched from GitHub based on
 * information in the document's query string.
 */
export class GitHubContentProvider extends ChangesContentProvider implements vscode.FileSystemProvider {
	constructor(private readonly folderRepositoryManager: FolderRepositoryManager, private _gitHubRepository: GitHubRepository) {
		super();
	}

	set gitHubRepository(repository: GitHubRepository) {
		this._gitHubRepository = repository;
	}

	async readFile(uri: vscode.Uri): Promise<Uint8Array> {
		const asParams = fromGitHubURI(uri);
		const tryReadFile = await this.tryReadFile(uri, asParams);
		if (tryReadFile) {
			return tryReadFile;
		}

		const content = await getGitHubFileContent(this._gitHubRepository, asParams!.fileName, asParams!.branch);
		this.changedFiles.set(uri.toString(), { file: content, modified: false });
		return this.changedFiles.get(uri.toString())!.file;
	}

	async applyChanges(commitMessage: string, branch: string): Promise<boolean> {
		const changes: Map<string, Uint8Array> = new Map();
		for (const [uri, fileData] of this.changedFiles) {
			if (fileData.modified) {
				changes.set(vscode.Uri.parse(uri).path, fileData.file);
			}
		}
		const result = await this._gitHubRepository.commit(branch, commitMessage, changes);
		if (result && this.folderRepositoryManager.repository.state.HEAD?.name === branch) {
			await this.folderRepositoryManager.repository.pull();
		}
		return result;
	}
}

export class GitContentProvider extends ChangesContentProvider implements vscode.FileSystemProvider {
	constructor(public folderRepositoryManager: FolderRepositoryManager) {
		super();
	}

	async readFile(uri: vscode.Uri): Promise<Uint8Array> {
		const params = fromGitHubURI(uri);
		if (!params || params.isEmpty) {
			return new TextEncoder().encode('');
		}

		const content = await getGitFileContent(this.folderRepositoryManager, params.fileName, params.branch, !!params.isEmpty);
		this.changedFiles.set(uri.toString(), { file: content, modified: false });
		return this.changedFiles.get(uri.toString())!.file;
	}

	async applyChanges(commitMessage: string): Promise<boolean> {
		if (this.folderRepositoryManager.repository.state.indexChanges.length > 0 || this.folderRepositoryManager.repository.state.workingTreeChanges.length > 0) {
			vscode.window.showWarningMessage('Please commit or stash your other changes before applying these changes.');
			return false;
		}

		const uris: string[] = [];
		for (const [uri, fileData] of this.changedFiles) {
			if (fileData.modified) {
				const fileUri = vscode.Uri.joinPath(this.folderRepositoryManager.repository.rootUri, vscode.Uri.parse(uri).path);
				await vscode.workspace.fs.writeFile(fileUri, fileData.file);
				uris.push(fileUri.fsPath);
			}
		}
		await this.folderRepositoryManager.repository.add(uris);
		await this.folderRepositoryManager.repository.commit(commitMessage);
		if (this.folderRepositoryManager.repository.state.HEAD?.upstream) {
			await this.folderRepositoryManager.repository.push(this.folderRepositoryManager.repository.state.HEAD.upstream.remote, this.folderRepositoryManager.repository.state.HEAD.upstream.name);
			return true;
		}
		return false;
	}
}