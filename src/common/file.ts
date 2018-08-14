/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as tmp from 'tmp';
import { DiffHunk } from './diffHunk';
import { exec } from './git';

export async function writeTmpFile(content: string, ext: string): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		tmp.file({ postfix: ext }, async (err: any, tmpFilePath: string) => {
			if (err) {
				reject(err);
				return;
			}

			try {
				fs.appendFileSync(tmpFilePath, content);
				resolve(tmpFilePath);
			} catch (ex) {
				reject(ex);
			}
		});
	});
}

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

export class RichFileChange {
	public blobUrl: string;
	constructor(
		public readonly filePath: string,
		public readonly originalFilePath: string,
		public readonly status: GitChangeType,
		public readonly fileName: string,
		public readonly diffHunks: DiffHunk[],
		public readonly isPartial: boolean
	) { }
}

export class SlimFileChange {
	constructor(
		public readonly blobUrl: string,
		public readonly status: GitChangeType,
		public readonly fileName: string
	) { }
}