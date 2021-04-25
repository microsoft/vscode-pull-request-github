import { SinonSandbox } from 'sinon';
import { createMock } from 'ts-auto-mock';
import { AzdoRepository, IMetadata } from '../../azdo/azdoRepository';
import { CredentialStore } from '../../azdo/credentials';
import { FileReviewedStatusService } from '../../azdo/fileReviewedStatusService';
import { Remote } from '../../common/remote';
import { MockTelemetry } from './mockTelemetry';

export class MockAzdoRepository extends AzdoRepository {
	constructor(remote: Remote, credentialStore: CredentialStore, telemetry: MockTelemetry, sinon: SinonSandbox) {
		const fileReviewedStatusService: any = sinon.createStubInstance(FileReviewedStatusService);
		super(remote, credentialStore, fileReviewedStatusService, telemetry);

		this._metadata = createMock<IMetadata>();

		this._initialized = true;
	}

	async ensure() {
		return this;
	}

	buildMetadata(metadata: IMetadata) {
		this._metadata = metadata;
	}
}
