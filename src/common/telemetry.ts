import * as vscode from 'vscode';
import Logger from './logger';
import { StatsStore, AppName, ISettings, IStatsDatabase, IMetrics, getYearMonthDay } from 'telemetry-github';
import { ITelemetry } from '../github/interface';

const TELEMETRY_KEY = 'vscode-pull-request-github.telemetry';
const CONFIG_SECTION = 'optout';

export class Telemetry implements ITelemetry {
	private _version; string;
	private _telemetry: StatsStore;
	constructor(private readonly _context: vscode.ExtensionContext) {
		this._version = vscode.extensions.getExtension('GitHub.vscode-pull-request-github').packageJSON.version;
		const database = new MementoDatabase(this._context, () => this._telemetry.createReport());
		this._telemetry = new StatsStore(AppName.VSCode, this._version,
			() => '',
			new VSSettings(this._context),
			database
		);
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
		this._config = vscode.workspace.getConfiguration('githubPullRequests.telemetry');

		const deprecated = vscode.workspace.getConfiguration('telemetry');
		const { globalValue, workspaceFolderValue, workspaceValue } = deprecated.inspect(CONFIG_SECTION);
		const values = [
			{ target: vscode.ConfigurationTarget.Global, value: globalValue },
			{ target: vscode.ConfigurationTarget.WorkspaceFolder, value: workspaceFolderValue },
			{ target: vscode.ConfigurationTarget.Workspace, value: workspaceValue },
		].filter(({ value }) => value !== undefined);

		if (values.length > 0) {
			values.forEach(({ target, value }) => {
				this._config.update(CONFIG_SECTION, value, target);
				deprecated.update(CONFIG_SECTION, undefined, target);
			});
		}
	}
	getItem(key: string): Promise<string> {
		switch (key) {
			case 'last-daily-stats-report':
				return Promise.resolve(this._context.globalState.get<string>(`${TELEMETRY_KEY}.last`));
			case 'stats-guid':
				return Promise.resolve(this._context.globalState.get<string>(`${TELEMETRY_KEY}.guid`));
			case 'has-sent-stats-opt-in-ping':
				return Promise.resolve(this._context.globalState.get<string>(`${TELEMETRY_KEY}.pinged`));
			case 'stats-opt-out':
				return Promise.resolve(this._config.get(CONFIG_SECTION));
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
				return Promise.resolve(this._config.update(CONFIG_SECTION, value));
		}
		return Promise.resolve(this._config.update(key, value));
	}
}

interface DBEntry {
	date: number;
	instanceId: string;
	metrics: IMetrics;
}

const now = () => new Date(Date.now()).toISOString();

/** This stores the telemetry data if the user has not opted out and until it is sent out */
class MementoDatabase implements IStatsDatabase {

	constructor(private readonly _context: vscode.ExtensionContext, private readonly _createReport: () => IMetrics) { }

	public close(): Promise<void> {
		return Promise.resolve();
	}

	public async addCustomEvent(instanceId: string, eventType: string, customEvent: any): Promise<void> {
		const report = await this.getCurrentDBEntry(instanceId);
		customEvent.date = now();
		customEvent.eventType = eventType;
		report.metrics.customEvents.push(customEvent);
		await this.update(report);
	}

	public async incrementCounter(instanceId: string, counterName: string): Promise<void> {
		const report = await this.getCurrentDBEntry(instanceId);
		if (!report.metrics.measures.hasOwnProperty(counterName)) {
			report.metrics.measures[counterName] = 0;
		}
		report.metrics.measures[counterName]++;
		await this.update(report);
	}

	public async addTiming(instanceId: string, eventType: string, durationInMilliseconds: number, metadata = {}): Promise<void> {
		const report = await this.getCurrentDBEntry(instanceId);
		report.metrics.timings.push({ eventType, durationInMilliseconds, metadata, date: now() });
		await this.update(report);
	}

	/** Clears all values that exist in the database.
	   * returns nothing.
	   */
	public async clearData(date?: Date): Promise<void> {
		if (!date) {
			this.metrics = [];
		} else {
			const today = getYearMonthDay(date);
			this.metrics = this.metrics.filter(x => x.date >= today);
		}
	}

	public async getMetrics(beforeDate?: Date): Promise<IMetrics[]> {
		if (beforeDate) {
			const today = getYearMonthDay(beforeDate);
			let metrics = this.metrics.filter(x => x.date < today).map(x => x.metrics);
			return metrics;
		} else {
			return this.metrics.map(x => x.metrics);
		}
	}

	public getCurrentMetrics(instanceId: string): Promise<IMetrics> {
		return this.getCurrentDBEntry(instanceId).then(x => x.metrics);
	}

	private async getCurrentDBEntry(instanceId: string): Promise<DBEntry> {
		let report = this.metrics.find(x => x.instanceId === instanceId);

		if (!report) {
			let newReport = this._createReport();
			const today = getYearMonthDay(new Date(Date.now()));
			report = { date: today, instanceId, metrics: newReport };
			let metrics = this.metrics;
			metrics.push(report);
			this.metrics = metrics;
		}
		return report;
	}

	private update(report: DBEntry) {
		let metrics = this.metrics;
		for (let i = 0; i < metrics.length; i++) {
			if (metrics[i].instanceId === report.instanceId) {
				metrics[i] = report;
				break;
			}
		}
		this.metrics = metrics;
	}

	private get metrics() {
		try {
			return (this._context.globalState.get<DBEntry[]>(TELEMETRY_KEY) || []);
		} catch { }
		return [];
	}

	private set metrics(entries: DBEntry[]) {
		this._context.globalState.update(TELEMETRY_KEY, entries);
	}
}
