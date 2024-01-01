/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import TelemetryReporter from '@vscode/extension-telemetry';
import * as vscode from 'vscode';
import {
	getExperimentationService,
	IExperimentationService,
	IExperimentationTelemetry,
	TargetPopulation,
} from 'vscode-tas-client';

/* __GDPR__
	"query-expfeature" : {
		"ABExp.queriedFeature": { "classification": "SystemMetaData", "purpose": "FeatureInsight" }
	}
*/

export class ExperimentationTelemetry implements IExperimentationTelemetry {
	private sharedProperties: Record<string, string> = {};

	constructor(private baseReporter: TelemetryReporter | undefined) { }

	sendTelemetryEvent(eventName: string, properties?: Record<string, string>, measurements?: Record<string, number>) {
		this.baseReporter?.sendTelemetryEvent(
			eventName,
			{
				...this.sharedProperties,
				...properties,
			},
			measurements,
		);
	}

	sendTelemetryErrorEvent(
		eventName: string,
		properties?: Record<string, string>,
		_measurements?: Record<string, number>,
	) {
		this.baseReporter?.sendTelemetryErrorEvent(eventName, {
			...this.sharedProperties,
			...properties,
		});
	}

	setSharedProperty(name: string, value: string): void {
		this.sharedProperties[name] = value;
	}

	postEvent(eventName: string, props: Map<string, string>): void {
		const event: Record<string, string> = {};
		for (const [key, value] of props) {
			event[key] = value;
		}
		this.sendTelemetryEvent(eventName, event);
	}

	async dispose(): Promise<any> {
		return this.baseReporter?.dispose();
	}
}

function getTargetPopulation(): TargetPopulation {
	switch (vscode.env.uriScheme) {
		case 'vscode':
			return TargetPopulation.Public;
		case 'vscode-insiders':
			return TargetPopulation.Insiders;
		case 'vscode-exploration':
			return TargetPopulation.Internal;
		case 'code-oss':
			return TargetPopulation.Team;
		default:
			return TargetPopulation.Public;
	}
}

class NullExperimentationService implements IExperimentationService {
	readonly initializePromise: Promise<void> = Promise.resolve();
	readonly initialFetch: Promise<void> = Promise.resolve();

	isFlightEnabled(_flight: string): boolean {
		return false;
	}

	isCachedFlightEnabled(_flight: string): Promise<boolean> {
		return Promise.resolve(false);
	}

	isFlightEnabledAsync(_flight: string): Promise<boolean> {
		return Promise.resolve(false);
	}

	getTreatmentVariable<T extends boolean | number | string>(_configId: string, _name: string): T | undefined {
		return undefined;
	}

	getTreatmentVariableAsync<T extends boolean | number | string>(
		_configId: string,
		_name: string,
	): Promise<T | undefined> {
		return Promise.resolve(undefined);
	}
}

export async function createExperimentationService(
	context: vscode.ExtensionContext,
	experimentationTelemetry: ExperimentationTelemetry,
): Promise<IExperimentationService> {
	const id = context.extension.id;
	const name = context.extension.packageJSON['name'];
	const version: string = context.extension.packageJSON['version'];
	const targetPopulation = getTargetPopulation();

	// We only create a real experimentation service for the stable version of the extension, not insiders.
	return name === 'vscode-pull-request-github'
		? getExperimentationService(
			id,
			version,
			targetPopulation,
			experimentationTelemetry,
			context.globalState,
		)
		: new NullExperimentationService();
}
