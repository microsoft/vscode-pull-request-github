/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import { Dropdown } from './dropdown';
import { clickFixtureElement, defineComponentFixture, defineFixtureGroup } from '../fixtures/fixtureUtils';

function dropdownFixture({ open = false, disabled = false, busy = false, single = false } = {}) {
	return defineComponentFixture({
		view: 'activityBar', width: 400,
		render: () => <Dropdown
			options={single ? { comment: 'Comment' } : { comment: 'Comment', approve: 'Approve', requestChanges: 'Request Changes' }}
			defaultOption="comment"
			disabled={disabled}
			submitAction={() => busy ? new Promise<void>(() => {}) : Promise.resolve()}
		/>,
		prepare: open ? clickFixtureElement('button[aria-label="Expand button options"]') : busy ? clickFixtureElement('input[type="submit"]') : undefined,
	});
}

export default defineFixtureGroup({ path: 'Components/Dropdown' }, {
	Closed: dropdownFixture(),
	Open: dropdownFixture({ open: true }),
	Disabled: dropdownFixture({ disabled: true }),
	Submitting: dropdownFixture({ busy: true }),
	SingleOption: dropdownFixture({ single: true }),
});
