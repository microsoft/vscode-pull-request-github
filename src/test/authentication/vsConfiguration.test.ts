import assert = require('assert');
import * as vscode from 'vscode';
import { migrateConfiguration } from '../../authentication/vsConfiguration';
import { promiseFromEvent } from '../../common/utils';

describe('VSCodeConfiguration', () => {
	it('should migrate deprecated hosts setting', async () => {
		const HOSTS = 'hosts';
		const GLOBAL = vscode.ConfigurationTarget.Global;
		const old = vscode.workspace.getConfiguration('githubPullRequests');
		const older = vscode.workspace.getConfiguration('github');
		const oldHosts = [
			{
				host: 'https://github.local',
				username: 'octocat',
				token: 'winning-token'
			}
		];

		const olderHosts = [
			{
				host: 'https://github.local',
				username: 'octocat',
				token: 'losing-token'
			},
			{
				host: 'https://ghe.local',
				username: 'octocat',
				token: 'ghe-token',
			}
		];

		const reset = async () => {
			// Reset the workspace
			await old.update(HOSTS, undefined, GLOBAL);
			await older.update(HOSTS, undefined, GLOBAL);
		};
		await reset();

		// Change setting to force migration to run
		await old.update(HOSTS, oldHosts, GLOBAL);
		await older.update(HOSTS, olderHosts, GLOBAL);

		const configDidChange = promiseFromEvent(vscode.workspace.onDidChangeConfiguration);

		const keychain: any[] = [], setMockKeychain = (...args: any[]) => keychain.push(args);
		await migrateConfiguration(setMockKeychain as any);
		await configDidChange;

		assert.equal(keychain.length, 3);
		assert.deepStrictEqual(keychain[0], ['https://github.local', 'losing-token']);
		assert.deepStrictEqual(keychain[1], ['https://ghe.local', 'ghe-token']);
		assert.deepStrictEqual(keychain[2], ['https://github.local', 'winning-token']);

		assert.deepStrictEqual(old.get(HOSTS), []);
		assert.deepStrictEqual(older.get(HOSTS), []);

		await reset();
	});
});
