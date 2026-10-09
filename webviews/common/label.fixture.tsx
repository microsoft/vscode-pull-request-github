/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import { Label } from './label';
import { PullRequest } from '../../src/github/views';
import { defineComponentFixture, defineFixtureGroup, defineThemeVariants, FixtureTheme } from '../fixtures/fixtureUtils';

function labelsFixture(defaultTheme: FixtureTheme, width = 720) {
	return defineComponentFixture({
		defaultTheme, width,
		render: renderLabels,
	});
}

function renderLabels(pr: PullRequest) {
	return <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
		{[
			{ name: 'bug', color: 'd73a4a' },
			{ name: 'enhancement', color: 'a2eeef' },
			{ name: 'good first issue', color: '7057ff' },
			{ name: 'needs additional accessibility testing', color: 'ffffff' },
			{ name: 'blocked', color: '000000' },
		].map(label => <Label key={label.name} {...label} displayName={label.name} canDelete={false} isDarkTheme={pr.isDarkTheme} />)}
	</div>;
}

export default defineFixtureGroup({ path: 'Components/Labels' }, {
	Default: defineThemeVariants(defaultTheme => labelsFixture(defaultTheme)),
	Narrow: defineThemeVariants(defaultTheme => labelsFixture(defaultTheme, 360)),
});
