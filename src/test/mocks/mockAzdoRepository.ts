import { SinonSandbox } from 'sinon';
import { AzdoRepository, IMetadata } from '../../azdo/azdoRepository';
import { CredentialStore } from '../../azdo/credentials';
import { Remote } from '../../common/remote';
import { MockTelemetry } from './mockTelemetry';
import { createMock } from 'ts-auto-mock';

export class MockAzdoRepository extends AzdoRepository {

	constructor(
		remote: Remote,
		credentialStore: CredentialStore,
		telemetry: MockTelemetry,
		sinon: SinonSandbox
	) {
		super(remote, credentialStore, telemetry);

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