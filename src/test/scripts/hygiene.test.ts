/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import { once } from 'events';
import filter from 'gulp-filter';
import * as path from 'path';
import Vinyl from 'vinyl';

const { indentationFilter }: { indentationFilter: string[] } = require(
	path.resolve(__dirname, '../../../../build/filters.js')
);

describe('Hygiene indentation filter', () => {
	it('excludes YAML workflows without excluding source files', async () => {
		const root = path.resolve(__dirname, '../../../..');
		const checked: string[] = [];
		const stream = filter(indentationFilter);
		stream.on('data', (file: { relative: string }) => checked.push(file.relative));
		const ended = once(stream, 'end');

		for (const filename of [
			'azure-pipeline.pr.yml',
			'.github/workflows/copilot-setup-steps.yml',
			'src/extension.ts',
			'.github/script.js'
		]) {
			stream.write(new Vinyl({
				cwd: root,
				base: root,
				path: path.join(root, filename),
				contents: Buffer.from('')
			}));
		}
		stream.end();
		await ended;

		assert.deepStrictEqual(checked, [
			path.join('src', 'extension.ts'),
			path.join('.github', 'script.js')
		]);
	});
});
