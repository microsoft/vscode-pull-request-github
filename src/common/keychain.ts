import * as vscode from 'vscode';

// keytar depends on a native module shipped in vscode, so this is
// how we load it
import * as keytarType from 'keytar';

function getNodeModule<T>(moduleName: string): T | undefined {
	const vscodeRequire = eval('require');
	try {
		return vscodeRequire(`${vscode.env.appRoot}/node_modules.asar/${moduleName}`);
	} catch (err) {
		// Not in ASAR.
	}
	try {
		return vscodeRequire(`${vscode.env.appRoot}/node_modules/${moduleName}`);
	} catch (err) {
		// Not available.
	}
	return undefined;
}

export const keychain = getNodeModule<typeof keytarType>('keytar');
