import * as assert from 'assert';
import * as utils from '../../common/utils';
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
});