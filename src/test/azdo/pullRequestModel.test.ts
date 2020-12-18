import * as vscode from 'vscode';
import { SinonSandbox, createSandbox } from 'sinon';
import { CredentialStore } from '../../azdo/credentials';
import { MockCommandRegistry } from '../mocks/mockCommandRegistry';
import { MockTelemetry } from '../mocks/mockTelemetry';
import { Remote } from '../../common/remote';
import { Protocol } from '../../common/protocol';
import { AzdoRepository } from '../../azdo/azdoRepository';
import * as dotenv from 'dotenv';
import * as path from 'path';
import {expect} from 'chai';

describe('PullRequestModel', function () {
	let sinon: SinonSandbox;
	let credentialStore: CredentialStore;
	let telemetry: MockTelemetry;
	const url = 'https://dev.azure.com/anksinha/test/_git/test';
	const remote = new Remote('origin', url, new Protocol(url));

	this.timeout(1000000);

	before(function () {
		dotenv.config({ path: path.resolve(__dirname, '../../../.env')});
	});

	beforeEach(function () {
		sinon = createSandbox();
		MockCommandRegistry.install(sinon);

		const mockShowInputBox = sinon.stub(vscode.window, 'showInputBox');

		mockShowInputBox.resolves(process.env.VSCODE_PR_AZDO_TEST_PAT);

		telemetry = new MockTelemetry();
		credentialStore = new CredentialStore(telemetry);
	});

	afterEach(function () {
		sinon.restore();
	});

	describe('thread', function () {
		it('create new thread', async function () {
			await credentialStore.initialize();

			const azdoRepo = new AzdoRepository(remote, credentialStore, telemetry);
			const prModel = await azdoRepo.getPullRequest(7);

			const thread = await prModel?.createThread(`This thread was created at ${Date.now()}`);
			// tslint:disable-next-line: no-unused-expression
			expect(thread?.id).exist;
		});

		it('get all threads for a pr', async function () {
			await credentialStore.initialize();

			const azdoRepo = new AzdoRepository(remote, credentialStore, telemetry);
			const prModel = await azdoRepo.getPullRequest(7);

			const threads = await prModel?.getAllThreads();
			console.log(threads?.[0].id);
			// tslint:disable-next-line: no-unused-expression
			expect(threads?.length).to.be.greaterThan(0);
		});
	});
});