import * as vscode from 'vscode';
import Logger from './logger';
import { StatsStore, AppName, ISettings, IStatsDatabase, ICounter } from 'telemetry-github';
import { ITelemetry } from '../github/interface';

const TELEMETRY_KEY = 'vscode-pull-request-github.telemetry';

export class Telemetry implements ITelemetry {
	private _version; string;
	private _telemetry: StatsStore;
	constructor(private readonly _context: vscode.ExtensionContext) {
		this._version = vscode.extensions.getExtension('Microsoft.vscode-pull-request-github').packageJSON.version;
		this._telemetry = new StatsStore(AppName.VSCode, this._version,
			() => '',
			new VSSettings(this._context),
			new MementoDatabase(this._context));
	}

	public on(action: string): Promise<void> {
		return this._telemetry.incrementCounter(action).catch(e => Logger.appendLine(e));
	}

	public shutdown(): Promise<void> {
		return this._telemetry.shutdown().catch(e => Logger.appendLine(e));
	}
}

/** This backend provides access to data such as:
 * - last time stats were reported (stored in memento)
 * - whether the user has opted out from telemetry reports (stored in vscode settings)
 * */
class VSSettings implements ISettings {
	private _config: vscode.WorkspaceConfiguration;
	constructor(private readonly _context: vscode.ExtensionContext) {
		this._config = vscode.workspace.getConfiguration('telemetry');
	}
	getItem(key: string): Promise<string> {
		switch (key) {
			case 'last-daily-stats-report': {
				let ret = this._context.globalState.get<string>(`${TELEMETRY_KEY}.last`);
				return Promise.resolve(ret);
			}
			case 'stats-guid':
				return Promise.resolve(this._context.globalState.get<string>(`${TELEMETRY_KEY}.guid`));
			case 'has-sent-stats-opt-in-ping':
				return Promise.resolve(this._context.globalState.get<string>(`${TELEMETRY_KEY}.pinged`));
			case 'stats-opt-out':
				return Promise.resolve(this._config.get('optout'));
		}
		return Promise.resolve(this._config.get(key));
	}

	setItem(key: string, value: string): Promise<void> {
		switch (key) {
			case 'last-daily-stats-report':
				return Promise.resolve(this._context.globalState.update(`${TELEMETRY_KEY}.last`, value));
			case 'stats-guid':
				return Promise.resolve(this._context.globalState.update(`${TELEMETRY_KEY}.guid`, value));
			case 'has-sent-stats-opt-in-ping':
				return Promise.resolve(this._context.globalState.update(`${TELEMETRY_KEY}.pinged`, value));
			case 'stats-opt-out':
				return Promise.resolve(this._config.update('optout', value));
		}
		return Promise.resolve(this._config.update(key, value));
	}
}

/** This stores the telemetry data if the user has not opted out and until it is sent out */
class MementoDatabase implements IStatsDatabase {
	constructor(private readonly _context: vscode.ExtensionContext) { }
	close(): Promise<void> {
		return Promise.resolve();
	}

	incrementCounter(counterName: string): Promise<void> {
		const counters = new Map<string, ICounter>();
		(this._context.globalState.get<ICounter[]>(TELEMETRY_KEY) || []).forEach(x => counters.set(x.name, x));
		const counter = counters.get(counterName) || { name: counterName, count: 0 };
		counter.count++;
		counters.set(counterName, counter);
		this._context.globalState.update(TELEMETRY_KEY, Array.from(counters.values()));
		return Promise.resolve();
	}

	async getCounters(): Promise<ICounter[]> {
		return this._context.globalState.get<ICounter[]>(TELEMETRY_KEY);
	}

	clearData(): Promise<void> {
		this._context.globalState.update(TELEMETRY_KEY, []);
		return Promise.resolve();
	}

	/** not being tracked right now */
	addCustomEvent(eventType: string, customEvent: any): Promise<void> {
		return Promise.resolve();
	}

	/** not being tracked right now */
	addTiming(eventType: string, durationInMilliseconds: number, metadata: object): Promise<void> {
		return Promise.resolve();
	}

	async getCustomEvents(): Promise<object[]> {
		return Promise.resolve([]);
	}

	async getTimings(): Promise<object[]> {
		return Promise.resolve([]);
	}
}
