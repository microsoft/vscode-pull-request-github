
import * as vscode from 'vscode';
import { GitExtension } from '../typings/git';

export function getAPI() {
	const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git').exports;
	const git = gitExtension.getAPI(1);
	return git;
}
