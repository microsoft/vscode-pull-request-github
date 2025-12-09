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
	readonly additions?: number;
	readonly deletions?: number;
}

export class InMemFileChange implements SimpleFileChange {
	constructor(
		public readonly baseCommit: string,
		public readonly status: GitChangeType,
		public readonly fileName: string,
		public readonly previousFileName: string | undefined,
		public readonly patch: string,
		public readonly diffHunks: DiffHunk[] | undefined,
		public readonly blobUrl: string,
		public readonly additions?: number,
		public readonly deletions?: number,
	) { }
}

export class SlimFileChange implements SimpleFileChange {
	constructor(
		public readonly baseCommit: string,
		public readonly blobUrl: string,
		public readonly status: GitChangeType,
		public readonly fileName: string,
		public readonly previousFileName: string | undefined,
		public readonly additions?: number,
		public readonly deletions?: number,
	) { }
}
