/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'path';
import TelemetryReporter from 'vscode-extension-telemetry';
import { getExperimentationService, IExperimentationService, IExperimentationTelemetry, TargetPopulation } from 'vscode-tas-client';

/* __GDPR__
	"query-expfeature" : {
		"ABExp.queriedFeature": { "classification": "SystemMetaData", "purpose": "FeatureInsight" }
	}
*/

interface ProductConfiguration {
	quality?: 'stable' | 'insider' | 'exploration';
}

async function getProductConfig(appRoot: string): Promise<ProductConfiguration> {
	const raw = await vscode.workspace.fs.readFile(vscode.Uri.file(path.join(appRoot, 'product.json')));
	return JSON.parse(raw.toString());
}

interface PackageConfiguration {
	name: string;
	publisher: string;
	version: string;
}

async function getPackageConfig(packageFolder: string): Promise<PackageConfiguration> {
	const raw = await vscode.workspace.fs.readFile(vscode.Uri.file(path.join(packageFolder, 'package.json')));
	return JSON.parse(raw.toString());
}

export class ExperimentationTelemetry implements IExperimentationTelemetry {

	private sharedProperties: Record<string, string> = {};

	constructor(private baseReporter: TelemetryReporter) { }

	sendTelemetryEvent(eventName: string, properties?: Record<string, string>, measurements?: Record<string, number>) {
		this.baseReporter.sendTelemetryEvent(eventName, {
			...this.sharedProperties,
			...properties
		}, measurements);
	}

	sendTelemetryErrorEvent(eventName: string, properties?: Record<string, string>, measurements?: Record<string, number>) {
		this.baseReporter.sendTelemetryErrorEvent(eventName, {
			...this.sharedProperties,
			...properties
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

	dispose(): Promise<any> {
		return this.baseReporter.dispose();
	}
}

function getTargetPopulation(product: ProductConfiguration): TargetPopulation {
	switch (product.quality) {
		case 'stable': return TargetPopulation.Public;
		case 'insider': return TargetPopulation.Insiders;
		case 'exploration': return TargetPopulation.Internal;
		case undefined: return TargetPopulation.Team;
		default: return TargetPopulation.Public;
	}
}

class NullExperimentationService implements IExperimentationService {
	readonly initializePromise: Promise<void> = Promise.resolve();

	isFlightEnabled(flight: string): boolean {
		return false;
	}

	isCachedFlightEnabled(flight: string): Promise<boolean> {
		return Promise.resolve(false);
	}

	isFlightEnabledAsync(flight: string): Promise<boolean> {
		return Promise.resolve(false);
	}

	getTreatmentVariable<T extends boolean | number | string>(configId: string, name: string): T | undefined {
		return undefined;
	}

	getTreatmentVariableAsync<T extends boolean | number | string>(configId: string, name: string): Promise<T | undefined> {
		return Promise.resolve(undefined);
	}
}

export async function createExperimentationService(context: vscode.ExtensionContext, experimentationTelemetry: ExperimentationTelemetry): Promise<IExperimentationService> {
	const pkg = await getPackageConfig(context.extensionPath);
	const product = await getProductConfig(vscode.env.appRoot);
	const targetPopulation = getTargetPopulation(product);

	// We only create a real experimentation service for the stable version of the extension, not insiders.
	return pkg.name === 'vscode-pull-request-github'
		? getExperimentationService(`${pkg.publisher}.${pkg.name}`, pkg.version, targetPopulation, experimentationTelemetry, context.globalState)
		: new NullExperimentationService();
}
