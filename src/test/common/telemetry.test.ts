import { strict as assert } from 'assert';
import * as vscode from 'vscode';

describe('Telemetry', () => {
	let disposable: vscode.Disposable;

	beforeEach(function () {
		disposable = new vscode.Disposable(() => {});
	});

	afterEach(function () {
		disposable.dispose();
	});

	it('should migrate deprecated optout setting', async () => {
		const migrated = vscode.workspace.getConfiguration('azdoPullRequests.telemetry');
		const target = vscode.ConfigurationTarget.Global;

		// Reset the workspace
		await migrated.update('enabled', undefined, target);

		disposable = vscode.workspace.onDidChangeConfiguration(async () => {
			assert.equal(migrated.get('enabled'), false);

			// Clean up the workspace
			await migrated.update('enabled', undefined, target);
		});
	});
});
