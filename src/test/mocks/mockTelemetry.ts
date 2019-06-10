import { ITelemetry } from '../../github/interface';

export class MockTelemetry implements ITelemetry {
	private events: string[] = [];
	private alive = true;

	on(action: 'startup'): Promise<void>;
	on(action: 'authSuccess'): Promise<void>;
	on(action: 'commentsFromEditor'): Promise<void>;
	on(action: 'commentsFromDescription'): Promise<void>;
	on(action: 'prListExpandLocalPullRequest'): Promise<void>;
	on(action: 'prListExpandRequestReview'): Promise<void>;
	on(action: 'prListExpandAssignedToMe'): Promise<void>;
	on(action: 'prListExpandMine'): Promise<void>;
	on(action: 'prListExpandAll'): Promise<void>;
	on(action: 'prCheckoutFromContext'): Promise<void>;
	on(action: 'prCheckoutFromDescription'): Promise<void>;
	on(action: string): Promise<void> {
		this.events.push(action);
		return Promise.resolve();
	}

	shutdown(): Promise<void> {
		this.alive = false;
		return Promise.resolve();
	}

	didSeeAction(action: string): boolean {
		return this.events.some(e => e === action);
	}

	actionCount(action: string): number {
		return this.events.reduce((count, act) => count + (act === action ? 1 : 0), 0);
	}

	wasShutdown() {
		return !this.alive;
	}
}