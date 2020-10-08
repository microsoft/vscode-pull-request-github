import assert = require('assert');
import * as vscode from 'vscode';

describe('Telemetry', () => {
	let disposable: vscode.Disposable;

	beforeEach(function () {
		disposable = new vscode.Disposable(() => { });
	});

	afterEach(function () {
		disposable.dispose();
	});

	it('should migrate deprecated optout setting', async () => {
		const deprecated = vscode.workspace.getConfiguration('telemetry');
		const migrated = vscode.workspace.getConfiguration('githubPullRequests.telemetry');
		const target = vscode.ConfigurationTarget.Global;

		// Reset the workspace
		await deprecated.update('optout', undefined, target);
		await migrated.update('enabled', undefined, target);

		// Change setting to force migration to run
		await deprecated.update('optout', true, target);

		disposable = vscode.workspace.onDidChangeConfiguration(async () => {
			assert.equal(deprecated.get('optout'), undefined);
			assert.equal(migrated.get('enabled'), false);

			// Clean up the workspace
			await deprecated.update('optout', undefined, target);
			await migrated.update('enabled', undefined, target);
		});
	});
});
