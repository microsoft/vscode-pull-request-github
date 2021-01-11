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
import { CommentThreadStatus } from 'azure-devops-node-api/interfaces/GitInterfaces';
import { PullRequestVote } from '../../azdo/interface';

describe('PullRequestModel', function () {
	let sinon: SinonSandbox;
	let credentialStore: CredentialStore;
	let telemetry: MockTelemetry;
	const url = 'https://dev.azure.com/anksinha/test/_git/test';
	const remote = new Remote('origin', url, new Protocol(url));

	const PR_NUMBER = 7;

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

	describe('commit', function () {
		it('get files changed in the PR', async function () {
			try {
				await credentialStore.initialize();

				const azdoRepo = new AzdoRepository(remote, credentialStore, telemetry);
				const prModel = await azdoRepo.getPullRequest(PR_NUMBER);

				const files = await prModel?.getFileChangesInfo();

				expect(files?.length).to.be.greaterThan(0);
			} catch (e) {
				// tslint:disable-next-line: no-unused-expression
				throw e;
			}
		});

		it('get all commits in PR', async function () {
			await credentialStore.initialize();

			const azdoRepo = new AzdoRepository(remote, credentialStore, telemetry);
			const prModel = await azdoRepo.getPullRequest(PR_NUMBER);

			const commits = await prModel?.getCommits();

			expect(commits?.length).to.be.greaterThan(0);
		});

		it('get commit changes', async function () {
			await credentialStore.initialize();

			const azdoRepo = new AzdoRepository(remote, credentialStore, telemetry);
			const prModel = await azdoRepo.getPullRequest(PR_NUMBER);

			const changes = await prModel?.getCommitChanges({commitId: '75b5626cb4f8f2f2b40e2a4e47c6f040cba23169'});

			// tslint:disable-next-line: no-unused-expression
			expect(changes?.length).to.be.greaterThan(0);
		});

		it('get file content', async function () {
			await credentialStore.initialize();

			const azdoRepo = new AzdoRepository(remote, credentialStore, telemetry);
			const prModel = await azdoRepo.getPullRequest(PR_NUMBER);

			const content = await prModel?.getFile('8c2d0fd0a22b924dada06305cabe964bf763249a');

			// tslint:disable-next-line: no-unused-expression
			expect(content?.length).to.be.greaterThan(0);
		});
	});

	describe('thread', function () {
		it('get all threads for a pr', async function () {
			await credentialStore.initialize();

			const azdoRepo = new AzdoRepository(remote, credentialStore, telemetry);
			const prModel = await azdoRepo.getPullRequest(PR_NUMBER);

			const threads = await prModel?.getAllActiveThreadsBetweenAllIterations();

			// tslint:disable-next-line: no-unused-expression
			expect(threads?.length).to.be.greaterThan(0);
		});

		it('create new thread', async function () {
			await credentialStore.initialize();

			const azdoRepo = new AzdoRepository(remote, credentialStore, telemetry);
			const prModel = await azdoRepo.getPullRequest(PR_NUMBER);

			const thread = await prModel?.createThread(`This thread was created at ${Date.now()}`);
			// tslint:disable-next-line: no-unused-expression
			expect(thread?.id).exist;
		});

		it('create new thread on specific line', async function () {
			await credentialStore.initialize();

			const azdoRepo = new AzdoRepository(remote, credentialStore, telemetry);
			const prModel = await azdoRepo.getPullRequest(PR_NUMBER);

			const thread = await prModel?.createThread(`This thread was created at ${Date.now()}`, { filePath: '/README.md', line: 2, startOffset: 0, endOffset: 0 });
			// tslint:disable-next-line: no-unused-expression
			expect(thread?.id).exist;
		});

		it('update thread status', async function () {
			await credentialStore.initialize();

			const azdoRepo = new AzdoRepository(remote, credentialStore, telemetry);
			const prModel = await azdoRepo.getPullRequest(PR_NUMBER);

			const threads = await prModel?.updateThreadStatus(11, CommentThreadStatus.Closed);

			// tslint:disable-next-line: no-unused-expression
			expect(threads?.status).to.be.eq(CommentThreadStatus.Closed);
		});

		it('create comment on a thread', async function () {
			await credentialStore.initialize();

			const azdoRepo = new AzdoRepository(remote, credentialStore, telemetry);
			const prModel = await azdoRepo.getPullRequest(PR_NUMBER);

			const comment = await prModel?.createCommentOnThread(11, `This comment was created at ${Date.now()}`);

			expect(comment?.id).to.be.greaterThan(0);
		});

		it('edit a thread message', async function () {
			await credentialStore.initialize();

			const azdoRepo = new AzdoRepository(remote, credentialStore, telemetry);
			const prModel = await azdoRepo.getPullRequest(PR_NUMBER);

			const message = Date.now().toString();

			const thread = await prModel?.editThread(message, 11, 1);

			// tslint:disable-next-line: no-unused-expression
			expect(thread?.content).to.be.eq(message);
		});

		it('edit a comment in a thread', async function () {
			await credentialStore.initialize();

			const azdoRepo = new AzdoRepository(remote, credentialStore, telemetry);
			const prModel = await azdoRepo.getPullRequest(PR_NUMBER);

			const message = Date.now().toString();

			const thread = await prModel?.editThread(message, 11, 2);

			// tslint:disable-next-line: no-unused-expression
			expect(thread?.content).to.be.eq(message);
		});
	});

	describe('vote', function () {
		it('cast a vote', async function() {
			await credentialStore.initialize();

			const azdoRepo = new AzdoRepository(remote, credentialStore, telemetry);
			const prModel = await azdoRepo.getPullRequest(PR_NUMBER);

			const vote = await prModel?.submitVote(PullRequestVote.REJECTED);

			expect(vote?.id).to.be.eq(azdoRepo.azdo?.authenticatedUser?.id);
		});
	});
});