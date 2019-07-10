
import { ITelemetry } from '../../common/telemetry';

export class MockTelemetry implements ITelemetry {
	sendTelemetryEvent() { }
	sendTelemetryException() { }
	dispose() { return Promise.resolve(); }
}