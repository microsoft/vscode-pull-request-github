
import { ITelemetry } from '../../common/telemetry';

export class MockTelemetry implements ITelemetry {
	sendTelemetryEvent() { }
	sendTelemetryErrorEvent() { }
	dispose() { return Promise.resolve(); }
}