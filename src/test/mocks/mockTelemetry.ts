/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ITelemetry } from '../../common/telemetry';

export class MockTelemetry implements ITelemetry {
	sendTelemetryEvent(_eventName: string, _properties?: Record<string, string>, _measurements?: Record<string, number>) { }
	sendTelemetryErrorEvent(_eventName: string, _properties?: Record<string, string>, _measurements?: Record<string, number>) { }
	dispose() {
		return Promise.resolve();
	}
}
