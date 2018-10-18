import * as assert from 'assert';
import * as vscode from 'vscode';
import { VSCodeConfiguration } from '../../authentication/vsConfiguration';

describe('VSCodeConfiguration', () => {
	it('should migrate deprecated hosts setting', async () => {
		const key = 'hosts';
		const deprecated = vscode.workspace.getConfiguration('github');
		const migrated = vscode.workspace.getConfiguration('githubPullRequests');
		const target = vscode.ConfigurationTarget.Global;
		const hosts = [
			{
				host: 'https://github.local',
				username: 'octocat',
				token: 'abcd1234'
			}
		];

		// Reset the workspace
		await deprecated.update(key, undefined, target);
		await migrated.update(key, undefined, target);

		// Change setting to force migration to run
		await deprecated.update(key, hosts, target);

		vscode.workspace.onDidChangeConfiguration(async () => {
			assert.equal(deprecated.get(key), undefined);
			assert.equal(migrated.get(key), hosts);

			// Clean up the workspace
			await deprecated.update(key, undefined, target);
			await migrated.update(key, undefined, target);
		});

		const configuration = new VSCodeConfiguration();

		await configuration.loadConfiguration();
	});
});
