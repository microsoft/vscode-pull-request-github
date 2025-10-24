/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';

const CODICONS_DIR = path.join(__dirname, '..', 'resources', 'icons', 'codicons');
const BASE_URL = 'https://raw.githubusercontent.com/microsoft/vscode-codicons/refs/heads/mrleemurray/new-icons/src/icons';

interface UpdateResult {
	filename: string;
	status: 'updated' | 'unchanged' | 'error';
	error?: string;
}

function readLocalIconFilenames(): string[] {
	return fs.readdirSync(CODICONS_DIR).filter(f => f.endsWith('.svg'));
}

function fetchRemoteIcon(filename: string): Promise<string> {
	const url = `${BASE_URL}/${encodeURIComponent(filename)}`;
	return new Promise((resolve, reject) => {
		https.get(url, res => {
			const { statusCode } = res;
			if (statusCode !== 200) {
				res.resume(); // drain
				return reject(new Error(`Failed to fetch ${filename}: HTTP ${statusCode}`));
			}
			let data = '';
			res.setEncoding('utf8');
			res.on('data', chunk => { data += chunk; });
			res.on('end', () => resolve(data));
		}).on('error', reject);
	});
}

async function updateIcon(filename: string): Promise<UpdateResult> {
	const localPath = path.join(CODICONS_DIR, filename);
	const oldContent = fs.readFileSync(localPath, 'utf8');
	try {
		const newContent = await fetchRemoteIcon(filename);
		if (normalize(oldContent) === normalize(newContent)) {
			return { filename, status: 'unchanged' };
		}
		fs.writeFileSync(localPath, newContent, 'utf8');
		return { filename, status: 'updated' };
	} catch (err: any) {
		return { filename, status: 'error', error: err?.message ?? String(err) };
	}
}

function normalize(svg: string): string {
	return svg.replace(/\r\n?/g, '\n').trim();
}

async function main(): Promise<void> {
	const icons = readLocalIconFilenames();
	if (!icons.length) {
		console.log('No codicon SVGs found to update.');
		return;
	}
	console.log(`Updating ${icons.length} codicon(s) from upstream...`);

	const concurrency = 8;
	const queue = icons.slice();
	const results: UpdateResult[] = [];

	async function worker(): Promise<void> {
		while (queue.length) {
			const file = queue.shift();
			if (!file) {
				break;
			}
			const result = await updateIcon(file);
			results.push(result);
			if (result.status === 'updated') {
				console.log(` ✔ ${file} updated`);
			} else if (result.status === 'unchanged') {
				console.log(` • ${file} unchanged`);
			} else {
				// allow-any-unicode-next-line
				console.warn(` ✖ ${file} ${result.error}`);
			}
		}
	}

	const workers = Array.from({ length: Math.min(concurrency, icons.length) }, () => worker());
	await Promise.all(workers);

	const updated = results.filter(r => r.status === 'updated').length;
	const unchanged = results.filter(r => r.status === 'unchanged').length;
	const errored = results.filter(r => r.status === 'error').length;
	console.log(`Done. Updated: ${updated}, Unchanged: ${unchanged}, Errors: ${errored}.`);
	if (errored) {
		process.exitCode = 1;
	}
}

main().catch(err => {
	console.error(err?.stack || err?.message || String(err));
	process.exit(1);
});

export { }; // ensure this file is treated as a module
