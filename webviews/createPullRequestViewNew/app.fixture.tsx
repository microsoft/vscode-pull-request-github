/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import { ChooseRemoteAndBranch, StackOption } from './app';
import { StackCandidate } from '../../common/views';
import { defineComponentFixture, defineFixtureGroup } from '../fixtures/fixtureUtils';

function StackChoice({ candidate, disabled }: { candidate: StackCandidate; disabled: boolean }) {
	const [checked, setChecked] = React.useState(false);
	return <StackOption candidate={candidate} checked={checked} disabled={disabled} onChange={setChecked} />;
}

function stackFixture(existing = false, disabled = false) {
	return defineComponentFixture({
		view: 'create', width: 400,
		render: () => <StackChoice disabled={disabled} candidate={{
			parentPullRequestNumber: 101, stackNumber: existing ? 7 : undefined, size: existing ? 3 : 1,
			url: 'https://github.com/octocat/component-explorer/pull/101',
		}} />,
	});
}

function branchFixture(branch: string | undefined, remoteCount: number, disabled = false) {
	return defineComponentFixture({
		view: 'create', width: 400,
		render: () => <ChooseRemoteAndBranch
			onClick={() => Promise.resolve()}
			defaultRemote={branch ? { owner: 'octocat', repositoryName: 'component-explorer' } : undefined}
			defaultBranch={branch} isBase={true} remoteCount={remoteCount} disabled={disabled}
		/>,
	});
}

const stack = defineFixtureGroup({
	NewStack: stackFixture(),
	ExistingStack: stackFixture(true),
	Disabled: stackFixture(true, true),
});

const branch = defineFixtureGroup({
	Default: branchFixture('main', 1),
	Fork: branchFixture('feature/keyboard-navigation', 2),
	LongBranch: branchFixture('feature/keep-keyboard-focus-stable-after-background-refresh', 2),
	Loading: branchFixture(undefined, 0, true),
	Disabled: branchFixture('main', 1, true),
});

export default defineFixtureGroup({ path: 'Views/Create pull request' }, {
	'Stack option': stack,
	'Branch picker': branch,
});
