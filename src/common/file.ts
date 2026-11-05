/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DiffHunk } from './diffHunk';

export enum GitChangeType {
	ADD,
	COPY,
	DELETE,
	MODIFY,
	RENAME,
	TYPE,
	UNKNOWN,
	UNMERGED,
}

export interface SimpleFileChange {
	readonly status: GitChangeType;
	readonly fileName: string;
	readonly blobUrl: string | undefined;
	readonly diffHunks?: DiffHunk[];
}

export class InMemFileChange implements SimpleFileChange {
	public readonly submoduleChange?: { base: string; head: string };

	constructor(
		public readonly baseCommit: string,
		public readonly status: GitChangeType,
		public readonly fileName: string,
		public readonly previousFileName: string | undefined,
		public readonly patch: string,
		public readonly diffHunks: DiffHunk[] | undefined,
		public readonly blobUrl: string,
		objectSha?: string,
	) {
		// The files API omits tree modes. A gitlink's patch holds one commit pointer per side, and its object sha is the
		// pointed-to commit, which a regular file's blob sha can never be.
		const groups = /^@@ -(?:0,0|1(?:,1)?) \+(?:0,0|1(?:,1)?) @@\n(?:-(?<base>Subproject commit (?<baseSha>[a-f\d]{40}))(?:\n|$))?(?:\+(?<head>Subproject commit (?<headSha>[a-f\d]{40}))\n?)?$/.exec(patch.replace(/\r\n/g, '\n'))?.groups;
		const pointerSha = groups?.headSha ?? groups?.baseSha;
		if (groups && pointerSha && pointerSha === objectSha) {
			this.submoduleChange = {
				base: groups.base ? `${groups.base}\n` : '',
				head: groups.head ? `${groups.head}\n` : '',
			};
		}
	}
}

export class SlimFileChange implements SimpleFileChange {
	constructor(
		public readonly baseCommit: string,
		public readonly blobUrl: string,
		public readonly status: GitChangeType,
		public readonly fileName: string,
		public readonly previousFileName: string | undefined,
	) { }
}
