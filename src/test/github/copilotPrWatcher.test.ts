/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import { CopilotStateModel } from '../../github/copilotPrWatcher';
import { CopilotPRStatus } from '../../common/copilot';
import { PullRequestModel } from '../../github/pullRequestModel';

describe('Copilot PR watcher', () => {

	describe('CopilotStateModel', () => {

		const createPullRequest = (owner: string, repo: string, number: number): PullRequestModel => {
			return {
				number,
				remote: { owner, repositoryName: repo },
				author: { login: 'copilot' }
			} as unknown as PullRequestModel;
		};

		it('creates consistent keys and reports refresh events', () => {
			const model = new CopilotStateModel();
			let refreshEvents = 0;
			model.onRefresh(() => refreshEvents++);

			assert.strictEqual(model.makeKey('octo', 'repo'), 'octo/repo');
			assert.strictEqual(model.makeKey('octo', 'repo', 7), 'octo/repo#7');

			model.clear();
			assert.strictEqual(refreshEvents, 1);
		});

		it('stores statuses and emits notifications after initialization', () => {
			const model = new CopilotStateModel();
			let changeEvents = 0;
			const notifications: PullRequestModel[][] = [];
			model.onDidChangeStates(() => changeEvents++);
			model.onDidChangeNotifications(items => notifications.push(items));

			const pr = createPullRequest('octo', 'repo', 1);
			model.set([{ pullRequestModel: pr, status: CopilotPRStatus.Started }]);

			assert.strictEqual(model.get('octo', 'repo', 1), CopilotPRStatus.Started);
			assert.strictEqual(changeEvents, 1);
			assert.strictEqual(notifications.length, 0);
			assert.strictEqual(model.notifications.size, 0);

			model.set([{ pullRequestModel: pr, status: CopilotPRStatus.Started }]);
			assert.strictEqual(changeEvents, 1);

			model.setInitialized();
			const updated = createPullRequest('octo', 'repo', 1);
			model.set([{ pullRequestModel: updated, status: CopilotPRStatus.Completed }]);

			assert.strictEqual(model.get('octo', 'repo', 1), CopilotPRStatus.Completed);
			assert.strictEqual(changeEvents, 2);
			assert.strictEqual(notifications.length, 1);
			assert.deepStrictEqual(notifications[0], [updated]);
			assert.ok(model.notifications.has('octo/repo#1'));
		});

		it('deletes keys and clears related notifications', () => {
			const model = new CopilotStateModel();
			let changeEvents = 0;
			const notifications: PullRequestModel[][] = [];
			model.onDidChangeStates(() => changeEvents++);
			model.onDidChangeNotifications(items => notifications.push(items));

			model.setInitialized();
			const pr = createPullRequest('octo', 'repo', 42);
			model.set([{ pullRequestModel: pr, status: CopilotPRStatus.Started }]);

			assert.strictEqual(model.notifications.size, 1);
			assert.strictEqual(changeEvents, 1);

			model.deleteKey('octo/repo#42');
			assert.strictEqual(model.get('octo', 'repo', 42), CopilotPRStatus.None);
			assert.strictEqual(changeEvents, 2);
			assert.strictEqual(model.notifications.size, 0);
			assert.strictEqual(notifications.length, 2);
			assert.deepStrictEqual(notifications[1], [pr]);
			assert.deepStrictEqual(model.keys(), []);
		});

		it('clears individual notifications and reports changes', () => {
			const model = new CopilotStateModel();
			const notifications: PullRequestModel[][] = [];
			model.onDidChangeNotifications(items => notifications.push(items));

			model.setInitialized();
			const pr = createPullRequest('octo', 'repo', 5);
			model.set([{ pullRequestModel: pr, status: CopilotPRStatus.Started }]);
			assert.strictEqual(model.notifications.size, 1);
			assert.strictEqual(notifications.length, 1);

			model.clearNotification('octo', 'repo', 5);
			assert.strictEqual(model.notifications.size, 0);
			assert.strictEqual(notifications.length, 2);
			assert.deepStrictEqual(notifications[1], [pr]);

			model.clearNotification('octo', 'repo', 5);
			assert.strictEqual(notifications.length, 2);
		});

		it('supports clearing notifications by repository or entirely', () => {
			const model = new CopilotStateModel();
			const notifications: PullRequestModel[][] = [];
			model.onDidChangeNotifications(items => notifications.push(items));

			assert.strictEqual(model.isInitialized, false);
			model.setInitialized();
			assert.strictEqual(model.isInitialized, true);

			const prOne = createPullRequest('octo', 'repo', 1);
			const prTwo = createPullRequest('octo', 'repo', 2);
			const prThree = createPullRequest('other', 'repo', 3);
			model.set([
				{ pullRequestModel: prOne, status: CopilotPRStatus.Started },
				{ pullRequestModel: prTwo, status: CopilotPRStatus.Failed },
				{ pullRequestModel: prThree, status: CopilotPRStatus.Completed }
			]);

			assert.strictEqual(model.notifications.size, 3);
			assert.strictEqual(notifications.length, 1);
			assert.deepStrictEqual(notifications[0], [prOne, prTwo, prThree]);
			assert.strictEqual(model.getNotificationsCount('octo', 'repo'), 2);
			assert.deepStrictEqual(model.keys().sort(), ['octo/repo#1', 'octo/repo#2', 'other/repo#3']);

			model.clearAllNotifications('octo', 'repo');
			assert.strictEqual(model.notifications.size, 1);
			assert.strictEqual(model.getNotificationsCount('octo', 'repo'), 0);
			assert.strictEqual(notifications.length, 2);
			assert.deepStrictEqual(notifications[1], [prOne, prTwo]);

			model.clearAllNotifications();
			assert.strictEqual(model.notifications.size, 0);
			assert.strictEqual(notifications.length, 3);
			assert.deepStrictEqual(notifications[2], [prThree]);

			const counts = model.getCounts('octo', 'repo');
			assert.deepStrictEqual(counts, { total: 3, inProgress: 1, error: 1 });

			const allStates = model.all;
			assert.strictEqual(allStates.length, 3);
			assert.deepStrictEqual(allStates.map(v => v.status).sort(), [CopilotPRStatus.Started, CopilotPRStatus.Completed, CopilotPRStatus.Failed]);
		});
	});


});