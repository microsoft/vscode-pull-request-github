import * as vscode from 'vscode';
import { SinonSandbox } from 'sinon';

/**
 * Intercept calls to `vscode.commands.registerCommand` for the lifetime of a Sinon sandbox. Store the
 * registered commands locally for testing.
 *
 * Without this installed, functions that attempt to register commands that are also registered during extension
 * activation will collide with those.
 *
 * @example
 * describe('Class that registers commands', function() {
 *     let sinon: SinonSandbox;
 *     let commands: MockCommandRegistry;
 *
 * 	   beforeEach(function() {
 *         sinon = createSandbox();
 *         commands = new MockCommandRegistry(sinon);
 *     });
 *
 *     afterEach(function() {
 *         sinon.restore();
 *     });
 *
 *     it('registers its command', function() {
 *        registerTheCommands();
 *
 *        assert.strictEqual(commands.executeCommand('identity.function', 1), 1);
 *     });
 * });
 */
export class MockCommandRegistry {
	private _commands: { [commandName: string]: (args: any[]) => any } = {};

	static install(sinon: SinonSandbox) {
		new this(sinon);
	}

	constructor(sinon: SinonSandbox) {
		sinon.stub(vscode.commands, 'registerCommand').callsFake(this.registerCommand.bind(this));
	}

	private registerCommand(commandID: string, callback: (args: any[]) => any) {
		if (this._commands.hasOwnProperty(commandID)) {
			throw new Error(`Duplicate command registration: ${commandID}`);
		}

		this._commands[commandID] = callback;
		return {
			dispose: () => delete this._commands[commandID],
		};
	}

	executeCommand(commandID: string, ...rest: any[]): any {
		const callback = this._commands[commandID];
		if (!callback) {
			throw new Error(`Unrecognized command execution: ${commandID}`);
		}
		return callback(rest);
	}
}
