import * as path from 'path';
import { expect } from 'chai';
import * as dotenv from 'dotenv';
import { createSandbox, SinonSandbox } from 'sinon';
import { AzdoRepository } from '../../azdo/azdoRepository';
import { CredentialStore } from '../../azdo/credentials';
import { Protocol } from '../../common/protocol';
import { Remote } from '../../common/remote';
import { MockCommandRegistry } from '../mocks/mockCommandRegistry';
import { createFakeSecretStorage } from '../mocks/mockExtensionContext';
import { MockTelemetry } from '../mocks/mockTelemetry';
import { FileReviewedStatusService } from '../../azdo/fileReviewedStatusService';

describe('AzdoRepository', function () {
	let sinon: SinonSandbox;
	let credentialStore: CredentialStore;
	let telemetry: MockTelemetry;
	let fileReviewedStatusService;

	this.timeout(1000000);

	before(function () {
		dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
	});

	beforeEach(function () {
		sinon = createSandbox();
		MockCommandRegistry.install(sinon);

		const secretStorage = createFakeSecretStorage();

		telemetry = new MockTelemetry();
		credentialStore = new CredentialStore(telemetry, secretStorage);
		fileReviewedStatusService = sinon.createStubInstance(FileReviewedStatusService);
	});

	afterEach(function () {
		sinon.restore();
	});

	describe('getMetadata', function () {
		it('get repo information from Azdo', async function () {
			await credentialStore.initialize();
			const url = 'https://dev.azure.com/anksinha/test/_git/test';
			const remote = new Remote('origin', url, new Protocol(url));
			const azdoRepo = new AzdoRepository(remote, credentialStore, fileReviewedStatusService, telemetry);
			const metadata = await azdoRepo.getMetadata();
			expect(metadata?.name).to.be.eq('test');
		});
	});

	// describe('branch', function () {
	// 	it('get default branch', async function () {
	// 		await credentialStore.initialize();
	// 		const url = 'https://dev.azure.com/anksinha/test/_git/test';
	// 		const remote = new Remote('origin', url, new Protocol(url));
	// 		const azdoRepo = new AzdoRepository(remote, credentialStore, telemetry);
	// 		const branch = await azdoRepo.getDefaultBranch();
	// 		expect(branch).to.be.eq('main');
	// 	});

	// 	it('get specific branch', async function () {
	// 		await credentialStore.initialize();
	// 		const url = 'https://dev.azure.com/anksinha/test/_git/test';
	// 		const remote = new Remote('origin', url, new Protocol(url));
	// 		const azdoRepo = new AzdoRepository(remote, credentialStore, telemetry);
	// 		const branch = await azdoRepo.getBranchRef('main');
	// 		expect(branch?.ref).to.be.eq('main');
	// 	});
	// });

	// describe('pr', function () {
	// 	it('get all PRs', async function () {
	// 		await credentialStore.initialize();
	// 		const url = 'https://dev.azure.com/anksinha/test/_git/test';
	// 		const remote = new Remote('origin', url, new Protocol(url));
	// 		const azdoRepo = new AzdoRepository(remote, credentialStore, telemetry);
	// 		const prs = await azdoRepo.getAllPullRequests();
	// 		expect(prs?.length).to.be.greaterThan(2);
	// 	});

	// 	it('get PR for test_pr branch', async function () {
	// 		await credentialStore.initialize();
	// 		const url = 'https://dev.azure.com/anksinha/test/_git/test';
	// 		const remote = new Remote('origin', url, new Protocol(url));
	// 		const azdoRepo = new AzdoRepository(remote, credentialStore, telemetry);
	// 		const prs = await azdoRepo.getPullRequestForBranch('refs/heads/test_pr');
	// 		expect(prs?.length).to.be.greaterThan(0);
	// 	});

	// 	it('get PR for main branch', async function () {
	// 		await credentialStore.initialize();
	// 		const url = 'https://dev.azure.com/anksinha/test/_git/test';
	// 		const remote = new Remote('origin', url, new Protocol(url));
	// 		const azdoRepo = new AzdoRepository(remote, credentialStore, telemetry);
	// 		const prs = await azdoRepo.getPullRequestForBranch('refs/heads/main');
	// 		expect(prs?.length).to.be.eq(0);
	// 	});

	// 	it('get PR for deleted branch', async function () {
	// 		await credentialStore.initialize();
	// 		const url = 'https://dev.azure.com/anksinha/test/_git/test';
	// 		const remote = new Remote('origin', url, new Protocol(url));
	// 		const azdoRepo = new AzdoRepository(remote, credentialStore, telemetry);
	// 		const prs = await azdoRepo.getPullRequestForBranch('refs/heads/this_does_not_exist');
	// 		expect(prs?.length).to.be.eq(0);
	// 	});
	// });

	// describe('authenticatedUser', function () {
	// 	it('get my identity', async function () {
	// 		await credentialStore.initialize();
	// 		const url = 'https://dev.azure.com/anksinha/test/_git/test';
	// 		const remote = new Remote('origin', url, new Protocol(url));
	// 		const azdoRepo = new AzdoRepository(remote, credentialStore, telemetry);
	// 		const user = await azdoRepo.getAuthenticatedUser();
	// 		// tslint:disable-next-line: no-unused-expression
	// 		expect(user?.id).exist;
	// 	});

	// 	it('get my username', async function () {
	// 		await credentialStore.initialize();
	// 		const url = 'https://dev.azure.com/anksinha/test/_git/test';
	// 		const remote = new Remote('origin', url, new Protocol(url));
	// 		const azdoRepo = new AzdoRepository(remote, credentialStore, telemetry);
	// 		const user = await azdoRepo.getAuthenticatedUserName();
	// 		console.log(user);
	// 		// tslint:disable-next-line: no-unused-expression
	// 		expect(user).is.not.empty;
	// 	});
	// });
});
