import * as assert from 'assert';
import * as utils from '../../common/utils';
import { EventEmitter } from 'vscode';
import * as Octokit from '@octokit/rest';

describe('utils', () => {
	describe('formatError', () => {
		it('should format a normal error', () => {
			const error = new Error('No!');
			assert.equal(utils.formatError(error), 'No!');
		});

		it('should format an HttpError from octorest', (done) => {
			const octokit = new Octokit();
			octokit.pullRequests.getComments({
				number: 1,
				owner: 'me',
				repo: '犬?'
			}).then(_ => {
				assert.fail('managed the impossible');
				done();
			}).catch(e => {
				assert.equal(utils.formatError(e), 'Not Found');
				done();
			});
		});

		it('should format an error with submessages', () => {
			const error = new Error(`{"message":"Validation Failed","errors":[{"resource":"PullRequestReview","code":"custom","field":"user_id","message":"user_id can only have one pending review per pull request"}],"documentation_url":"https://developer.github.com/v3/pulls/comments/#create-a-comment"}`);
			assert.equal(utils.formatError(error), 'Validation Failed: user_id can only have one pending review per pull request');
		});

		it('should format an error with submessages that are strings', () => {
			const error = new Error(`{"message":"Validation Failed","errors":["Can not approve your own pull request"],"documentation_url":"https://developer.github.com/v3/pulls/reviews/#create-a-pull-request-review"}`);
			assert.equal(utils.formatError(error), 'Validation Failed: Can not approve your own pull request');
		});
	});

	describe.only('EventEmitter[toPromise]', () => {
		const hasListeners = (emitter: any) =>
			!emitter._listeners!.isEmpty();

		describe('without arguments', () => {
			it('should return a promise for the next event', async () => {
				const emitter = new EventEmitter<string>();
				const promise = emitter[utils.toPromise]();
				emitter.fire('hello');
				emitter.fire('world');
				const value = await promise;
				assert.equal(value, 'hello');
			});

			it('should unsubscribe after the promise resolves', async () => {
				const emitter = new EventEmitter<string>();
				const promise = emitter[utils.toPromise]();
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
				const promise = emitter[utils.toPromise](count);
				assert(hasListeners(emitter), 'should subscribe');
				emitter.fire('hell');
				const value = await promise;
				assert(!hasListeners(emitter), 'should unsubscribe');
				assert.equal(value, 'hell'.length);
			});

			it('should return a promise that rejects if the adapter does', async () => {
				const emitter = new EventEmitter<string>();
				const promise = emitter[utils.toPromise](count);
				assert(hasListeners(emitter), 'should subscribe');
				emitter.fire('hello');
				await promise
					.then(
						() => { throw new Error('promise should have rejected'); },
						e => assert.equal(e.message, 'the string is too damn long')
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
						{/* the door is silent */};

			const tick = () => new Promise(resolve => setImmediate(resolve));
			it('should stay subscribed until the adapter resolves', async () => {
				const emitter = new EventEmitter<string>();
				const promise = emitter[utils.toPromise](door);
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
		});
	});
});