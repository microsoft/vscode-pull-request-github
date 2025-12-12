/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Remote, Repository } from '../api/api';
import { Protocol } from './protocol';
import { parseRemote } from './remote';

export class GitHubRef {
	public repositoryCloneUrl: Protocol;
	constructor(public ref: string, public label: string, public sha: string, repositoryCloneUrl: string,
		public readonly owner: string, public readonly name: string, public readonly isInOrganization: boolean) {
		this.repositoryCloneUrl = new Protocol(repositoryCloneUrl);
	}
}

export function findLocalRepoRemoteFromGitHubRef(repository: Repository, gitHubRef: GitHubRef): Remote | undefined {
	const targetRepo = gitHubRef.repositoryCloneUrl.repositoryName.toLowerCase();
	const targetOwner = gitHubRef.owner.toLowerCase();
	for (const remote of repository.state.remotes) {
		const url = remote.fetchUrl ?? remote.pushUrl;
		if (!url) {
			continue;
		}
		const parsedRemote = parseRemote(remote.name, url);
		const parsedOwner = parsedRemote?.owner.toLowerCase();
		const parsedRepo = parsedRemote?.repositoryName.toLowerCase();
		if (parsedOwner === targetOwner && parsedRepo === targetRepo) {
			return remote;
		}
	}
}
