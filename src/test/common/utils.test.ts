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

	describe('uniqBy', () => {
		it('should remove duplicates based on key function', () => {
			const arr = [
				{ id: 1, name: 'Alice' },
				{ id: 2, name: 'Bob' },
				{ id: 1, name: 'Alice Clone' }, // duplicate id
				{ id: 3, name: 'Charlie' }
			];
			const result = utils.uniqBy(arr, (item) => item.id.toString());
			assert.strictEqual(result.length, 3);
			assert.strictEqual(result[0].name, 'Alice');
			assert.strictEqual(result[1].name, 'Bob');
			assert.strictEqual(result[2].name, 'Charlie');
		});

		it('should handle empty arrays', () => {
			const result = utils.uniqBy([], (item) => item.toString());
			assert.strictEqual(result.length, 0);
		});
	});

	describe('groupBy', () => {
		it('should group items by key function', () => {
			const arr = [
				{ type: 'bug', title: 'Bug 1' },
				{ type: 'feature', title: 'Feature 1' },
				{ type: 'bug', title: 'Bug 2' },
				{ type: 'docs', title: 'Doc 1' }
			];
			const result = utils.groupBy(arr, (item) => item.type);
			
			assert.strictEqual(Object.keys(result).length, 3);
			assert.strictEqual(result.bug.length, 2);
			assert.strictEqual(result.feature.length, 1);
			assert.strictEqual(result.docs.length, 1);
			assert.strictEqual(result.bug[0].title, 'Bug 1');
			assert.strictEqual(result.bug[1].title, 'Bug 2');
		});

		it('should handle empty arrays', () => {
			const result = utils.groupBy([], (item) => item.toString());
			assert.deepStrictEqual(result, {});
		});
	});

	describe('isDescendant', () => {
		it('should detect descendant paths', () => {
			assert.strictEqual(utils.isDescendant('/parent', '/parent/child', '/'), true);
			assert.strictEqual(utils.isDescendant('/parent', '/parent/child/grandchild', '/'), true);
			assert.strictEqual(utils.isDescendant('C:\\parent', 'C:\\parent\\child', '\\'), true);
		});

		it('should reject non-descendant paths', () => {
			assert.strictEqual(utils.isDescendant('/parent', '/different', '/'), false);
			assert.strictEqual(utils.isDescendant('/parent', '/parent-but-not-child', '/'), false);
			assert.strictEqual(utils.isDescendant('/parent/child', '/parent', '/'), false); // child is not descendant of grandchild
		});

		it('should handle same paths', () => {
			assert.strictEqual(utils.isDescendant('/same', '/same', '/'), false);
		});
	});
});
