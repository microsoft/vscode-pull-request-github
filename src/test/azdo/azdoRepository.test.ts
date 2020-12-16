import assert = require('assert');
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

describe('AzdoRepository', function () {
	let sinon: SinonSandbox;
	let credentialStore: CredentialStore;
	let telemetry: MockTelemetry;

	this.timeout(1000000);

	before(function () {
		const res = dotenv.config({ path: path.resolve(__dirname, '../../../.env')});
		console.log(res);
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

	describe('getMetadata', function () {
		it('get repo information from Azdo', async function () {
			await credentialStore.initialize();
			const url = 'https://dev.azure.com/anksinha/test/_git/test';
			const remote = new Remote('origin', url, new Protocol(url));
			const azdoRepo = new AzdoRepository(remote, credentialStore, telemetry);
			const metadata = await azdoRepo.getMetadata();
			assert(metadata?.name === 'test');
		});
	});

	describe('branch', function () {
		it('get default branch', async function () {
			await credentialStore.initialize();
			const url = 'https://dev.azure.com/anksinha/test/_git/test';
			const remote = new Remote('origin', url, new Protocol(url));
			const azdoRepo = new AzdoRepository(remote, credentialStore, telemetry);
			const branch = await azdoRepo.getDefaultBranch();
			assert(branch === 'main');
		});

		it('get specific branch', async function () {
			await credentialStore.initialize();
			const url = 'https://dev.azure.com/anksinha/test/_git/test';
			const remote = new Remote('origin', url, new Protocol(url));
			const azdoRepo = new AzdoRepository(remote, credentialStore, telemetry);
			const branch = await azdoRepo.getBranchRef('main');
			assert(branch?.ref === 'main');
		});
	});

	describe('pr', function () {
		it('get all PRs', async function () {
			await credentialStore.initialize();
			const url = 'https://dev.azure.com/anksinha/test/_git/test';
			const remote = new Remote('origin', url, new Protocol(url));
			const azdoRepo = new AzdoRepository(remote, credentialStore, telemetry);
			const prs = await azdoRepo.getAllPullRequests();
			assert(prs?.length || 0 > 2);
		});
	});
});