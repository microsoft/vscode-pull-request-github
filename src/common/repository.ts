/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { anyEvent, filterEvent, isDescendant, uniqBy } from './utils';
import Logger from './logger';
import { GitError, GitErrorCodes } from './gitError';
import { Protocol } from './protocol';
import { Remote } from './remote';
import { exec, IGitExecutionOptions } from './git';

export enum RefType {
	Head,
	RemoteHead,
	Tag
}

export interface Ref {
	type: RefType;
	name?: string;
	commit?: string;
	remote?: string;
}

export interface UpstreamRef {
	remote: string;
	name: string;
}

export interface Branch extends Ref {
	upstream?: UpstreamRef;
	ahead?: number;
	behind?: number;
}

export class Repository {
	public path: string;

	private _onDidRunGitStatus = new vscode.EventEmitter<void>();
	readonly onDidRunGitStatus: vscode.Event<void> = this._onDidRunGitStatus.event;

	private _HEAD: Branch | undefined;
	get HEAD(): Branch | undefined {
		return this._HEAD;
	}

	private _refs: Ref[] = [];
	get refs(): Ref[] {
		return this._refs;
	}

	private _remotes: Remote[] = [];
	get remotes(): Remote[] {
		return this._remotes;
	}

	private statusTimeout: any;
	private disposables: vscode.Disposable[] = [];

	constructor(path: string) {
		this.path = path;

		const fsWatcher = vscode.workspace.createFileSystemWatcher('**');
		this.disposables.push(fsWatcher);

		const onWorkspaceChange = anyEvent(fsWatcher.onDidChange, fsWatcher.onDidCreate, fsWatcher.onDidDelete);
		const onRepositoryChange = filterEvent(onWorkspaceChange, uri => isDescendant(this.path, uri.fsPath));
		const onRelevantRepositoryChange = filterEvent(onRepositoryChange, uri => !/\/\.git(\/index\.lock)?$/.test(uri.path));
		onRelevantRepositoryChange(this.onFSChange, this, this.disposables);

		this.status();
	}

	onFSChange() {
		clearTimeout(this.statusTimeout);

		this.statusTimeout = setTimeout(() => {
			this.status();
		}, 1000);
	}

	async status() {
		if (!this.path) {
			return;
		}

		let HEAD: Branch | undefined;

		try {
			HEAD = await this.getHEAD();

			if (HEAD.name) {
				try {
					HEAD = await this.getBranch(HEAD.name);
				} catch (err) {
					// noop
				}
			}
		} catch (err) {
			// noop
		}

		const [refs, remotes] = await Promise.all([this.getRefs(), this.getRemotes()]);
		this._HEAD = HEAD;
		this._refs = refs;
		this._remotes = remotes;
		this._onDidRunGitStatus.fire();
	}

	async run(args: string[], options: IGitExecutionOptions = {}) {
		Logger.appendLine(`> git ${args.join(' ')}`);
		return await exec(args, {
			...options,
			cwd: this.path
		});
	}

	async fetch(remoteName: string, branch?: string) {
		let args = [
			'fetch',
			remoteName
		];

		if (branch) {
			args.push(branch);
		}

		const result = await this.run(args);

		if (result.exitCode !== 0) {
			throw (result.stderr);
		}
	}

	async checkout(branch: string) {
		const result = await this.run(
			[
				'checkout',
				branch
			]
		);

		if (result.exitCode !== 0) {
			let rej = new GitError({
				stdout: result.stdout,
				stderr: result.stderr,
			});
			if (/error: Your local changes to the following files would be overwritten/.test(result.stderr || '')) {
				rej.gitErrorCode = GitErrorCodes.LocalChangesOverwritten;
			}
			throw rej;
		}
	}

	async getHEAD(): Promise<Ref> {
		if (!this.path) {
			return undefined;
		}

		try {
			const result = await this.run(['symbolic-ref', '--short', 'HEAD']);

			if (!result.stdout) {
				throw new Error('Not in a branch');
			}

			return { name: result.stdout.trim(), commit: void 0, type: RefType.Head };
		} catch (err) {
			const result = await this.run(['rev-parse', 'HEAD']);

			if (!result.stdout) {
				throw new Error('Error parsing HEAD');
			}

			return { name: void 0, commit: result.stdout.trim(), type: RefType.Head };
		}
	}

	async createBranch(branchName: string, tip?: string) {
		const result = await this.run(['branch', branchName, tip ? tip : '']);

		if (result.exitCode !== 0) {
			throw new Error(result.stderr);
		}
	}

	async getBranch(name: string): Promise<Branch> {
		if (name === 'HEAD') {
			return this.getHEAD();
		}

		const result = await this.run(['rev-parse', name]);

		if (result.exitCode !== 0 || !result.stdout) {
			return null;
		}

		const commit = result.stdout.trim();

		try {
			const res2 = await this.run(['rev-parse', '--symbolic-full-name', name + '@{u}']);
			const fullUpstream = res2.stdout.trim();
			const match = /^refs\/remotes\/([^/]+)\/(.+)$/.exec(fullUpstream);

			if (!match) {
				throw new Error(`Could not parse upstream branch: ${fullUpstream}`);
			}

			const upstream = { remote: match[1], name: match[2] };
			const res3 = await this.run(['rev-list', '--left-right', name + '...' + fullUpstream]);

			let ahead = 0, behind = 0;
			let i = 0;

			while (i < res3.stdout.length) {
				switch (res3.stdout.charAt(i)) {
					case '<': ahead++; break;
					case '>': behind++; break;
					default: i++; break;
				}

				while (res3.stdout.charAt(i++) !== '\n') { /* no-op */ }
			}

			return { name, type: RefType.Head, commit, upstream, ahead, behind };
		} catch (err) {
			return { name, type: RefType.Head, commit };
		}
	}

	async getLocalBranches(): Promise<string[]> {
		let result = await this.run(['branch']);

		if (result.exitCode !== 0) {
			return [];
		}

		return result.stdout.trimRight().split(/\r|\n|\r\n/).map(branchName => {
			return branchName.substr(2);
		});
	}

	async getRefs(): Promise<Ref[]> {
		const result = await this.run(['for-each-ref', '--format', '%(refname) %(objectname)', '--sort', '-committerdate']);

		const fn = (line: string): Ref | null => {
			let match: RegExpExecArray | null;

			if (match = /^refs\/heads\/([^ ]+) ([0-9a-f]{40})$/.exec(line)) {
				return { name: match[1], commit: match[2], type: RefType.Head };
			} else if (match = /^refs\/remotes\/([^/]+)\/([^ ]+) ([0-9a-f]{40})$/.exec(line)) {
				return { name: `${match[1]}/${match[2]}`, commit: match[3], type: RefType.RemoteHead, remote: match[1] };
			} else if (match = /^refs\/tags\/([^ ]+) ([0-9a-f]{40})$/.exec(line)) {
				return { name: match[1], commit: match[2], type: RefType.Tag };
			}

			return null;
		};

		return result.stdout.trim().split('\n')
			.filter(line => !!line)
			.map(fn)
			.filter(ref => !!ref) as Ref[];
	}

	async getRemotes(): Promise<Remote[]> {
		const result = await this.run(['remote', '--verbose']);
		const regex = /^([^\s]+)\s+([^\s]+)\s/;
		const rawRemotes = result.stdout.trim().split('\n')
			.filter(b => !!b)
			.map(line => regex.exec(line) as RegExpExecArray)
			.filter(g => !!g)
			.map((groups: RegExpExecArray) => ({ name: groups[1], url: groups[2] }));

		return uniqBy(rawRemotes, remote => remote.name)
			.map(remote => parseRemote(remote.name, remote.url))
			.filter(remote => !!remote);
	}

	async show(filePath: string): Promise<string> {
		try {
			const result = await this.run(['show', filePath]);
			return result.stdout.trim();
		} catch (e) {
			return null;
		}
	}

	async checkCommitExists(commit: string): Promise<boolean> {
		try {
			const result = await this.run(['show', '-q', commit]);
			return result.stdout.trim().length !== 0;
		} catch (e) {
			return false;
		}
	}

	async getFileObjectId(commit: string, path: string): Promise<string> {
		try {
			const args = ['rev-parse', `${commit}:${path}`];

			const result = await this.run(args);
			return result.stdout.trim();
		} catch (e) {
			return '';
		}
	}

	async hashObject(text: string): Promise<string> {
		try {

			const args = ['hash-object', '-w', '--stdin'];

			const result = await this.run(args, {
				stdin: text
			});
			return result.stdout.trim();
		} catch (e) {
			return '';
		}
	}

	async diffHashed(hash0: string, hash1: string) {
		try {
			const args = ['diff', hash0, hash1];
			const result = await this.run(args);
			return result.stdout.trim();
		} catch (e) {
			return '';
		}
	}

	async diff(filePath: string, compareWithCommit: string): Promise<string> {
		try {
			let args = ['diff', filePath];
			if (compareWithCommit) {
				args = ['diff', compareWithCommit, '--', filePath];
			}

			const result = await this.run(args);
			return result.stdout.trim();
		} catch (e) {
			return '';
		}
	}

	async setConfig(key: string, value: string) {
		await this.run(['config', '--local', key, value]);
	}

	async getConfig(key: string) {
		let result = await this.run(['config', '--local', '--get', key]);

		if (result.exitCode !== 0) {
			return null;
		}

		return result.stdout.trim();
	}

	async getConfigs() {
		let result = await this.run(['config', '--local', '-l']);

		if (result.exitCode !== 0) {
			return [];
		}

		let entries = result.stdout.trim().split(/\r|\r\n|\n/);

		return entries.map(entry => {
			let ret = entry.split('=');
			return {
				key: ret[0],
				value: ret[1]
			};
		});
	}

	async setTrackingBranch(localBranchName: string, trackedBranchName: string) {
		let result = await this.run(['branch', `--set-upstream-to=${trackedBranchName}`, localBranchName]);

		if (result.exitCode !== 0) {
			throw (result.exitCode);
		}
	}

	async addRemote(name: string, remoteUrl: string) {
		let result = await this.run(['remote', 'add', name, remoteUrl]);

		if (result.exitCode !== 0) {
			throw (result.exitCode);
		}
	}

	async isDirty(): Promise<boolean> {
		let result = await this.run(['diff', '--no-ext-diff', '--exit-code']);
		return result.exitCode !== 0;
	}

	async getMergeBase(a: string, b: string) {
		let result = await this.run(['merge-base', a, b]);
		if (result.exitCode === 0) {
			return result.stdout.trim();
		} else {
			return null;
		}
	}

	async checkFileExistence(commitSha: string, fileName: string): Promise<boolean> {
		let result = await this.run(['cat-file', '-e', `${commitSha}:` + fileName.replace(/\\/g, '/')]);

		return result.exitCode === 0;
	}
}

function parseRemote(remoteName: string, url: string): Remote | null {
	let gitProtocol = new Protocol(url);

	if (gitProtocol.host) {
		return new Remote(remoteName, url, gitProtocol);
	}

	return null;
}
