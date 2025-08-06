/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import * as utils from '../../common/utils';
import { EventEmitter } from 'vscode';
import * as timers from 'timers';

describe('utils', () => {
	class HookError extends Error {
		public errors: any[];

		constructor(message: string, errors: any[]) {
			super(message);
			this.errors = errors;
		}
	}

	describe('formatError', () => {
		it('should format a normal error', () => {
			const error = new Error('No!');
			assert.strictEqual(utils.formatError(error), 'No!');
		});

		it('should format an error with submessages', () => {
			const error = new HookError('Validation Failed', [
				{ message: 'user_id can only have one pending review per pull request' },
			]);
			assert.strictEqual(utils.formatError(error), 'user_id can only have one pending review per pull request');
		});

		it('should not format when error message contains all information', () => {
			const error = new HookError('Validation Failed: Some Validation error', []);
			assert.strictEqual(utils.formatError(error), 'Validation Failed: Some Validation error');
		});

		it('should format an error with submessages that are strings', () => {
			const error = new HookError('Validation Failed', ['Can not approve your own pull request']);
			assert.strictEqual(utils.formatError(error), 'Can not approve your own pull request');
		});

		it('should format an error with field errors', () => {
			const error = new HookError('Validation Failed', [{ field: 'title', value: 'garbage', status: 'custom' }]);
			assert.strictEqual(utils.formatError(error), 'Validation Failed: Value "garbage" cannot be set for field title (code: custom)');
		});

		it('should format an error with custom ', () => {
			const error = new HookError('Validation Failed', [{ message: 'Cannot push to this repo', status: 'custom' }]);
			assert.strictEqual(utils.formatError(error), 'Cannot push to this repo');
		});
	});

	describe('String and Config iterators (for session parsing context)', () => {
		it('should handle config key iteration for copilot settings', () => {
			const iterator = new utils.ConfigKeysIterator();
			iterator.reset('githubPullRequests.codingAgent.enabled');
			
			let segments: string[] = [];
			while (iterator.hasNext()) {
				segments.push(iterator.value());
				iterator.next();
			}
			if (!iterator.hasNext()) {
				segments.push(iterator.value());
			}

			assert.ok(segments.length > 0);
			assert.ok(segments.some(segment => segment.includes('githubPullRequests')));
		});

		it('should handle string iteration for tool names', () => {
			const iterator = new utils.StringIterator();
			iterator.reset('copilot-remote-agent');
			
			let chars: string[] = [];
			while (iterator.hasNext()) {
				chars.push(iterator.value());
				iterator.next();
			}
			if (!iterator.hasNext()) {
				chars.push(iterator.value());
			}

			assert.strictEqual(chars[0], 'c');
			assert.strictEqual(chars.join(''), 'copilot-remote-agent');
		});
	});
});
