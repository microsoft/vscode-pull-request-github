/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Commit } from '../api/api';
import { OctokitCommon } from '../github/common';
import { FolderRepositoryManager } from '../github/folderRepositoryManager';
import { GitHubRepository } from '../github/githubRepository';

export class CreatePullRequestDataModel {
	private _baseOwner: string;
	private _baseBranch: string;
	private _compareOwner: string;
	private _compareBranch: string;
	private readonly _onDidChange: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
	public readonly onDidChange = this._onDidChange.event;
	private _gitHubRepository: GitHubRepository | undefined;

	private _gitLog: Promise<Commit[]> | undefined;
	private _compareHasUpstream: boolean = false;

	private _gitHubMergeBase: string | undefined;
	private _gitHubLog: OctokitCommon.Commit[] | undefined;
	private _gitHubFiles: OctokitCommon.CommitFile[] | undefined;

	constructor(private readonly folderRepositoryManager: FolderRepositoryManager, baseOwner: string, baseBranch: string, compareOwner: string, compareBranch: string) {
		this._baseOwner = baseOwner;
		this._baseBranch = baseBranch;
		this.setCompareBranch(compareBranch);
		this.compareOwner = compareOwner;
	}

	public get baseOwner(): string {
		return this._baseOwner;
	}

	public set baseOwner(value: string) {
		if (value !== this._baseOwner) {
			this._baseOwner = value;
			this.update();
		}
	}

	public get baseBranch(): string {
		return this._baseBranch;
	}

	public set baseBranch(value: string) {
		if (value !== this._baseBranch) {
			this._baseBranch = value;
			this.update();
		}
	}

	public get compareOwner(): string {
		return this._compareOwner;
	}

	public set compareOwner(value: string) {
		if (value !== this._compareOwner) {
			this._compareOwner = value;
			this._gitHubRepository = this.folderRepositoryManager.gitHubRepositories.find(
				repo => repo.remote.owner === this._compareOwner,
			);
			this.update();
		}
	}

	public getCompareBranch(): string {
		return this._compareBranch;
	}

	public async setCompareBranch(value: string | undefined): Promise<void> {
		const oldUpstreamValue = this._compareHasUpstream;
		let changed: boolean = false;
		if (value) {
			changed = (await this.updateHasUpstream(value)) !== oldUpstreamValue;
		}
		if (this._compareBranch !== value) {
			changed = true;
			if (value) {
				this._compareBranch = value;
			}
		}
		if (changed) {
			this.update();
		}
	}

	private async updateHasUpstream(branch: string): Promise<boolean> {
		// Currently, the list of selectable compare branches it those on GitHub,
		// plus the current branch which may not be published yet. Check the
		// status of the current branch using local git, otherwise assume it is from
		// GitHub.
		if (this.folderRepositoryManager.repository.state.HEAD?.name === branch) {
			const compareBranch = await this.folderRepositoryManager.repository.getBranch(branch);
			this._compareHasUpstream = !!compareBranch.upstream;
		} else {
			this._compareHasUpstream = true;
		}
		return this._compareHasUpstream;
	}

	public get compareHasUpstream(): boolean {
		return this._compareHasUpstream;
	}

	public get gitHubRepository(): GitHubRepository | undefined {
		return this._gitHubRepository;
	}

	private update() {
		this._gitLog = undefined;
		this._gitHubLog = undefined;
		this._gitHubFiles = undefined;
		this._onDidChange.fire();
	}

	public async gitCommits(): Promise<Commit[]> {
		if (this._gitLog === undefined) {
			this._gitLog = this.folderRepositoryManager.repository.log({ range: `${this._baseBranch}..${this._compareBranch}` });
		}
		return this._gitLog;
	}

	public async gitHubCommits(): Promise<OctokitCommon.Commit[]> {
		if (!this._gitHubRepository) {
			return [];
		}

		if (this._gitHubLog === undefined) {
			const { octokit, remote } = await this._gitHubRepository.ensure();
			const { data } = await octokit.call(octokit.api.repos.compareCommits, {
				repo: remote.repositoryName,
				owner: remote.owner,
				base: `${this._baseOwner}:${this._baseBranch}`,
				head: `${this._compareOwner}:${this._compareBranch}`,
			});
			this._gitHubLog = data.commits;
			this._gitHubFiles = data.files ?? [];
			this._gitHubMergeBase = data.merge_base_commit.sha;
		}
		return this._gitHubLog;
	}

	public async gitHubFiles(): Promise<OctokitCommon.CommitFile[]> {
		if (this._gitHubFiles === undefined) {
			await this.gitHubCommits();
		}
		return this._gitHubFiles!;
	}

	public async gitHubMergeBase(): Promise<string> {
		if (this._gitHubMergeBase === undefined) {
			await this.gitHubCommits();
		}
		return this._gitHubMergeBase!;
	}
}