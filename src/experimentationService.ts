/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'path';
import TelemetryReporter from 'vscode-extension-telemetry';
import { getExperimentationService, IExperimentationTelemetry, TargetPopulation } from 'vscode-tas-client';

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

export async function createExperimentationService(context: vscode.ExtensionContext, experimentationTelemetry: ExperimentationTelemetry) {
	const pkg = await getPackageConfig(context.extensionPath);
	const product = await getProductConfig(vscode.env.appRoot);
	const targetPopulation = getTargetPopulation(product);

	return getExperimentationService(`${pkg.publisher}.${pkg.name}`, pkg.version, targetPopulation, experimentationTelemetry, context.globalState);
}
