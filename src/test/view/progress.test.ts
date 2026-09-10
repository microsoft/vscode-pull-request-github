/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import { ProgressHelper } from '../../view/progress';

describe('ProgressHelper', function () {
	it('ends progress when the task fails', async function () {
		const helper = new ProgressHelper();
		const error = new Error('Failed to update');
		let progressEnded = false;

		const task = helper.run(async () => {
			throw error;
		});
		helper.progress.then(() => {
			progressEnded = true;
		});

		await assert.rejects(task, candidate => candidate === error);
		await Promise.resolve();

		assert.strictEqual(progressEnded, true);
	});
});
