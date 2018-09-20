/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DiffHunk } from './diffHunk';
import { exec } from './git';

export async function getFileContent(rootDir: string, commitSha: string, sourceFilePath: string): Promise<string> {
	const result = await exec([
		'show',
		`${commitSha}:` + sourceFilePath.replace(/\\/g, '/')
	], {
		cwd: rootDir
	});

	const out = result.stdout;
	const error = result.stderr;

	if (result.exitCode === 0) {
		if (out.endsWith('\n')) {
			return out.substr(0, out.length - 1);
		}
		return out;
	} else {
		throw error;
	}
}

export enum GitChangeType {
	ADD,
	COPY,
	DELETE,
	MODIFY,
	RENAME,
	TYPE,
	UNKNOWN,
	UNMERGED
}

export class InMemFileChange {

	constructor(
		public readonly baseCommit: string,
		public readonly status: GitChangeType,
		public readonly fileName: string,
		public readonly previousFileName: string | undefined,
		public readonly patch: string,
		public readonly diffHunks: DiffHunk[],

		public readonly isPartial: boolean,
		public readonly blobUrl: string
	) { }
}

export class SlimFileChange {
	constructor(
		public readonly blobUrl: string,
		public readonly status: GitChangeType,
		public readonly fileName: string
	) { }
}