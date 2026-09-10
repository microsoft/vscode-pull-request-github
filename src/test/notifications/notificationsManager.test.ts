/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import { createSandbox, SinonSandbox } from 'sinon';
import { CredentialStore } from '../../github/credentials';
import { RepositoriesManager } from '../../github/repositoriesManager';
import { NotificationTreeItem } from '../../notifications/notificationItem';
import { NotificationsManager } from '../../notifications/notificationsManager';
import { NotificationsProvider } from '../../notifications/notificationsProvider';
import { MockCommandRegistry } from '../mocks/mockCommandRegistry';
import { MockExtensionContext } from '../mocks/mockExtensionContext';

describe('NotificationsManager', function () {
	let sinon: SinonSandbox;
	let manager: NotificationsManager;

	beforeEach(function () {
		sinon = createSandbox();
		MockCommandRegistry.install(sinon);
		manager = new NotificationsManager(
			{} as NotificationsProvider,
			{} as CredentialStore,
			{} as RepositoriesManager,
			new MockExtensionContext(),
		);
	});

	afterEach(function () {
		manager.dispose();
		sinon.restore();
	});

	it('clears cached notifications without fetching', function () {
		const notification = {} as NotificationTreeItem;
		const internal = manager as unknown as {
			_notifications: Map<string, NotificationTreeItem>;
			_fetchNotifications: boolean;
		};
		internal._notifications.set('notification', notification);
		internal._fetchNotifications = true;
		const onDidChangeNotifications = sinon.spy();
		const onDidChangeTreeData = sinon.spy();
		manager.onDidChangeNotifications(onDidChangeNotifications);
		manager.onDidChangeTreeData(onDidChangeTreeData);

		manager.clear();

		assert.strictEqual(internal._notifications.size, 0);
		assert.strictEqual(internal._fetchNotifications, false);
		assert.deepStrictEqual(onDidChangeNotifications.firstCall.args[0], [notification]);
		assert.strictEqual(onDidChangeTreeData.calledOnce, true);
	});
});
