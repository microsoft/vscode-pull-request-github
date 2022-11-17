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
			const error = new HookError('Validation Failed', [{ field: 'title', value: 'garbage', code: 'custom' }]);
			assert.strictEqual(utils.formatError(error), 'Validation Failed: Value "garbage" cannot be set for field title (code: custom)');
		});

		it('should format an error with custom ', () => {
			const error = new HookError('Validation Failed', [{ message: 'Cannot push to this repo', code: 'custom' }]);
			assert.strictEqual(utils.formatError(error), 'Cannot push to this repo');
		});
	});

	describe('promiseFromEvent', () => {
		describe('without arguments', () => {
			it('should return a promise for the next event', async () => {
				const emitter = new EventEmitter<string>();
				const promise = utils.promiseFromEvent(emitter.event);
				emitter.fire('hello');
				emitter.fire('world');
				const value = await promise;
				assert.strictEqual(value, 'hello');
			});
		});

		describe('with an adapter', () => {
			const count: utils.PromiseAdapter<string, number> = (str, resolve, reject) =>
				str.length <= 4 ? resolve(str.length) : reject(new Error('the string is too damn long'));

			it("should return a promise that uses the adapter's value", async () => {
				const emitter = new EventEmitter<string>();
				const promise = utils.promiseFromEvent(emitter.event, count);
				emitter.fire('hell');
				const value = await promise;
				assert.strictEqual(value, 'hell'.length);
			});

			it('should return a promise that rejects if the adapter does', async () => {
				const emitter = new EventEmitter<string>();
				const promise = utils.promiseFromEvent(emitter.event, count);
				emitter.fire('hello');
				await promise.then(
					() => {
						throw new Error('promise should have rejected');
					},
					e => assert.strictEqual(e.message, 'the string is too damn long'),
				);
			});

			it('should return a promise that rejects if the adapter throws', async () => {
				const emitter = new EventEmitter<string>();
				const promise = utils.promiseFromEvent(emitter.event, () => {
					throw new Error('kaboom');
				});
				emitter.fire('hello');
				await promise.then(
					() => {
						throw new Error('promise should have rejected');
					},
					e => assert.strictEqual(e.message, 'kaboom'),
				);
			});

			it('should return a promise that rejects if the adapter returns a rejecting Promise', async () => {
				const emitter = new EventEmitter<string>();
				const promise = utils.promiseFromEvent(emitter.event, async () => {
					throw new Error('kaboom');
				});
				emitter.fire('hello');
				await promise.then(
					() => {
						throw new Error('promise should have rejected');
					},
					e => assert.strictEqual(e.message, 'kaboom'),
				);
			});

			const door: utils.PromiseAdapter<string, boolean> = (password, resolve, reject) =>
				password === 'sesame'
					? resolve(true)
					: password === 'mellon'
						? reject(new Error('wrong fable'))
						: {
							/* the door is silent */
						};

			const tick = () => new Promise(resolve => timers.setImmediate(resolve));
			it('should stay subscribed until the adapter resolves', async () => {
				const emitter = new EventEmitter<string>();
				const promise = utils.promiseFromEvent(emitter.event, door);
				let hasResolved = false;
				promise.then(() => (hasResolved = true));
				emitter.fire('password');
				emitter.fire('12345');
				await tick();
				assert.strictEqual(hasResolved, false, "shouldn't have resolved yet");
				emitter.fire('sesame');
				await tick();
				assert.strictEqual(hasResolved, true, 'should have resolved');
			});

			it('should stay subscribed until the adapter rejects', async () => {
				const emitter = new EventEmitter<string>();
				const promise = utils.promiseFromEvent(emitter.event, door);
				let hasResolved = false,
					hasRejected = false;
				promise.then(
					() => (hasResolved = true),
					() => (hasRejected = true),
				);
				emitter.fire('password');
				emitter.fire('12345');
				await tick();
				assert.strictEqual(hasResolved, false, "shouldn't resolve");
				assert.strictEqual(hasRejected, false, "shouldn't have rejected yet");
				emitter.fire('mellon');
				await tick();
				assert.strictEqual(hasResolved, false, "shouldn't resolve");
				assert.strictEqual(hasRejected, true, 'should have rejected');
			});
		});
	});
});
