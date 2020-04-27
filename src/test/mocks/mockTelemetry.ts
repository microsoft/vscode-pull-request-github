
import { ITelemetry } from '../../common/telemetry';

export class MockTelemetry implements ITelemetry {
	sendTelemetryEvent() { }
	sendTelemetryException() { }
	sendTelemetryErrorEvent() { }
	dispose() { return Promise.resolve(); }
}