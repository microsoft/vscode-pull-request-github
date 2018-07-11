import * as assert from 'assert';
import * as utils from '../../common/utils';
import * as Octokit from '@octokit/rest';

describe('utils', () => {
	describe('formatError', () => {
		it('should format a normal error', () => {
			const error = new Error("No!");
			assert.equal(utils.formatError(error), "No!");
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
	});
});