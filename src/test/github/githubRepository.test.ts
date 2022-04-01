import { default as assert } from 'assert';
import { SinonSandbox, createSandbox } from 'sinon';
import { CredentialStore } from '../../github/credentials';
import { MockCommandRegistry } from '../mocks/mockCommandRegistry';
import { MockTelemetry } from '../mocks/mockTelemetry';
import { Remote } from '../../common/remote';
import { Protocol } from '../../common/protocol';
import { GitHubRepository } from '../../github/githubRepository';
import { MockSessionState } from '../mocks/mockSessionState';
import { Uri } from 'vscode';

describe('GitHubRepository', function () {
	let sinon: SinonSandbox;
	let credentialStore: CredentialStore;
	let telemetry: MockTelemetry;

	beforeEach(function () {
		sinon = createSandbox();
		MockCommandRegistry.install(sinon);

		telemetry = new MockTelemetry();
		credentialStore = new CredentialStore(telemetry);
	});

	afterEach(function () {
		sinon.restore();
	});

	describe('isGitHubDotCom', function () {
		it('detects when the remote is pointing to github.com', function () {
			const url = 'https://github.com/some/repo';
			const remote = new Remote('origin', url, new Protocol(url));
			const rootUri = Uri.file('C:\\users\\test\\repo');
			const dotcomRepository = new GitHubRepository(remote, rootUri, credentialStore, telemetry, new MockSessionState());
			assert(dotcomRepository.isGitHubDotCom);
		});

		it('detects when the remote is pointing somewhere other than github.com', function () {
			const url = 'https://github.enterprise.horse/some/repo';
			const remote = new Remote('origin', url, new Protocol(url));
			const rootUri = Uri.file('C:\\users\\test\\repo');
			const dotcomRepository = new GitHubRepository(remote, rootUri, credentialStore, telemetry, new MockSessionState());
			assert(!dotcomRepository.isGitHubDotCom);
		});
	});
});
