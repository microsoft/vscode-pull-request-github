/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import { CommitVerificationBadge } from './commitVerification';
import { CommitEvent } from '../../src/common/timelineEvent';
import { createAccount } from '../fixtures/data';
import { clickFixtureElement, defineComponentFixture, defineFixtureGroup } from '../fixtures/fixtureUtils';

function verificationFixture(verification: CommitEvent['verification'], open = false) {
	return defineComponentFixture({
		width: 620, height: open ? 330 : undefined,
		render: () => <CommitVerificationBadge verification={verification} committedDate={new Date('2025-01-15T10:00:00Z')} />,
		prepare: open ? clickFixtureElement('.verified-pill') : undefined,
	});
}

export default defineFixtureGroup({ path: 'Components/Commit verification' }, {
	Verified: verificationFixture({ verified: true, state: 'VALID' }),
	Unverified: verificationFixture({ verified: false, state: 'UNKNOWN_KEY' }),
	GitHubSignature: verificationFixture({ verified: true, state: 'VALID', wasSignedByGitHub: true }, true),
	GpgSignature: verificationFixture({ verified: true, state: 'VALID', signer: createAccount(), keyId: '1234567890ABCDEF', email: 'octocat@example.com' }, true),
	SshSignature: verificationFixture({ verified: true, state: 'VALID', signer: createAccount(), keyFingerprint: 'SHA256:fixture-public-key-fingerprint', email: 'octocat@example.com' }, true),
	UnknownKey: verificationFixture({ verified: false, state: 'UNKNOWN_KEY', keyId: '1234567890ABCDEF' }, true),
});
