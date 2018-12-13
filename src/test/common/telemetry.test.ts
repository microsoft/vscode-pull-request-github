import * as assert from 'assert';
import * as vscode from 'vscode';
import { Telemetry } from '../../common/telemetry';

const memento = {
	get(key) {
		return undefined;
	},
	update: (key, value) => Promise.resolve(value)
};

const context = {
	subscriptions: [],
	workspaceState: memento,
	globalState: memento,
	extensionPath: '',
	asAbsolutePath: relativePath => `/${relativePath}`,
	storagePath: '',
	logPath: '',
	globalStoragePath: ''
};

describe('Telemetry', () => {
	it('should migrate deprecated optout setting', async () => {
		const deprecated = vscode.workspace.getConfiguration('telemetry');
		const migrated = vscode.workspace.getConfiguration('githubPullRequests.telemetry');
		const target = vscode.ConfigurationTarget.Global;

		// Reset the workspace
		await deprecated.update('optout', undefined, target);
		await migrated.update('enabled', undefined, target);

		// Change setting to force migration to run
		await deprecated.update('optout', true, target);

		vscode.workspace.onDidChangeConfiguration(async () => {
			assert.equal(deprecated.get('optout'), undefined);
			assert.equal(migrated.get('enabled'), false);

			// Clean up the workspace
			await deprecated.update('optout', undefined, target);
			await migrated.update('enabled', undefined, target);
		});

		const telemetry = new Telemetry(context);

		telemetry.shutdown();
	});
});
