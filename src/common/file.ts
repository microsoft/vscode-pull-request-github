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
	) {
		// The files API omits tree modes, but gitlink patches contain only a single commit pointer on each side.
		const submodule = /^@@ -(?:0,0|1(?:,1)?) \+(?:0,0|1(?:,1)?) @@\n(?:-(?<base>Subproject commit [a-f\d]{40})(?:\n|$))?(?:\+(?<head>Subproject commit [a-f\d]{40})\n?)?$/.exec(patch.replace(/\r\n/g, '\n'));
		if (submodule?.groups?.base || submodule?.groups?.head) {
			this.submoduleChange = {
				base: submodule.groups.base ? `${submodule.groups.base}\n` : '',
				head: submodule.groups.head ? `${submodule.groups.head}\n` : '',
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
