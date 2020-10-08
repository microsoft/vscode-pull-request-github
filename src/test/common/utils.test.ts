import assert = require('assert');
import * as utils from '../../common/utils';
import { EventEmitter } from 'vscode';

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
			assert.equal(utils.formatError(error), 'No!');
		});

		it('should format an error with submessages', () => {
			const error = new HookError('Validation Failed', [{ message: 'user_id can only have one pending review per pull request' }]);
			assert.equal(utils.formatError(error), 'user_id can only have one pending review per pull request');
		});

		it('should format an error with submessages that are strings', () => {
			const error = new HookError('Validation Failed', ['Can not approve your own pull request']);
			assert.equal(utils.formatError(error), 'Can not approve your own pull request');
		});

		it('should format an error with field errors', () => {
			const error = new HookError('Validation Failed', [{ field: 'title', value: 'garbage', code: 'custom' }]);
			assert.equal(utils.formatError(error), 'Value "garbage" cannot be set for field title (code: custom)');
		});

		it('should format an error with custom ', () => {
			const error = new HookError('Validation Failed', [{ message: 'Cannot push to this repo', code: 'custom' }]);
			assert.equal(utils.formatError(error), 'Cannot push to this repo');
		});
	});

	describe('promiseFromEvent', () => {
		const hasListeners = (emitter: any) =>
			!emitter._listeners!.isEmpty();

		describe('without arguments', () => {
			it('should return a promise for the next event', async () => {
				const emitter = new EventEmitter<string>();
				const promise = utils.promiseFromEvent(emitter.event);
				emitter.fire('hello');
				emitter.fire('world');
				const value = await promise;
				assert.equal(value, 'hello');
			});

			it('should unsubscribe after the promise resolves', async () => {
				const emitter = new EventEmitter<string>();
				const promise = utils.promiseFromEvent(emitter.event);
				assert(hasListeners(emitter), 'should subscribe');
				emitter.fire('hello');
				await promise;
				assert(!hasListeners(emitter), 'should unsubscribe');
			});
		});

		describe('with an adapter', () => {
			const count: utils.PromiseAdapter<string, number> =
				(str, resolve, reject) =>
					str.length <= 4
						? resolve(str.length)
						: reject(new Error('the string is too damn long'));

			it('should return a promise that uses the adapter\'s value', async () => {
				const emitter = new EventEmitter<string>();
				const promise = utils.promiseFromEvent(emitter.event, count);
				assert(hasListeners(emitter), 'should subscribe');
				emitter.fire('hell');
				const value = await promise;
				assert(!hasListeners(emitter), 'should unsubscribe');
				assert.equal(value, 'hell'.length);
			});

			it('should return a promise that rejects if the adapter does', async () => {
				const emitter = new EventEmitter<string>();
				const promise = utils.promiseFromEvent(emitter.event, count);
				assert(hasListeners(emitter), 'should subscribe');
				emitter.fire('hello');
				await promise
					.then(
						() => { throw new Error('promise should have rejected'); },
						e => assert.equal(e.message, 'the string is too damn long')
					);
				assert(!hasListeners(emitter), 'should unsubscribe');
			});

			it('should return a promise that rejects if the adapter throws', async () => {
				const emitter = new EventEmitter<string>();
				const promise = utils.promiseFromEvent(
					emitter.event,
					() => { throw new Error('kaboom'); }
				);
				assert(hasListeners(emitter), 'should subscribe');
				emitter.fire('hello');
				await promise
					.then(
						() => { throw new Error('promise should have rejected'); },
						e => assert.equal(e.message, 'kaboom')
					);
				assert(!hasListeners(emitter), 'should unsubscribe');
			});

			it('should return a promise that rejects if the adapter returns a rejecting Promise', async () => {
				const emitter = new EventEmitter<string>();
				const promise = utils.promiseFromEvent(
					emitter.event,
					async () => { throw new Error('kaboom'); }
				);
				assert(hasListeners(emitter), 'should subscribe');
				emitter.fire('hello');
				await promise
					.then(
						() => { throw new Error('promise should have rejected'); },
						e => assert.equal(e.message, 'kaboom')
					);
				assert(!hasListeners(emitter), 'should unsubscribe');
			});

			const door: utils.PromiseAdapter<string, boolean> =
				(password, resolve, reject) =>
					password === 'sesame'
						? resolve(true)
						:
						password === 'mellon'
							? reject(new Error('wrong fable'))
							:
							{/* the door is silent */ };

			const tick = () => new Promise(resolve => setImmediate(resolve));
			it('should stay subscribed until the adapter resolves', async () => {
				const emitter = new EventEmitter<string>();
				const promise = utils.promiseFromEvent(emitter.event, door);
				let hasResolved = false; promise.then(() => hasResolved = true);
				emitter.fire('password');
				emitter.fire('12345');
				await tick();
				assert.equal(hasResolved, false, 'shouldn\'t have resolved yet');
				assert(hasListeners(emitter), 'should still be listening');
				emitter.fire('sesame');
				await tick();
				assert.equal(hasResolved, true, 'should have resolved');
				assert(!hasListeners(emitter), 'should have unsubscribed');
			});

			it('should stay subscribed until the adapter rejects', async () => {
				const emitter = new EventEmitter<string>();
				const promise = utils.promiseFromEvent(emitter.event, door);
				let hasResolved = false, hasRejected = false;
				promise.then(() => hasResolved = true, () => hasRejected = true);
				emitter.fire('password');
				emitter.fire('12345');
				await tick();
				assert.equal(hasResolved, false, 'shouldn\'t resolve');
				assert.equal(hasRejected, false, 'shouldn\'t have rejected yet');
				assert(hasListeners(emitter), 'should still be listening');
				emitter.fire('mellon');
				await tick();
				assert.equal(hasResolved, false, 'shouldn\'t resolve');
				assert.equal(hasRejected, true, 'should have rejected');
				assert(!hasListeners(emitter), 'should have unsubscribed');
			});
		});
	});
});