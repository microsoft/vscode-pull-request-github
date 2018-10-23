import { execFile } from 'child_process';
import { promisify } from 'util';
import { Repository } from '../typings/git';
import Logger from './logger';

const exec = promisify(execFile);

/**
 * Push a local branch to a remote.
 *
 * @param remote name of remote to push to
 * @param {string?} localBranch name of local branch to push (default: current branch)
 * @param {string?} remoteBranch name of remote branch (default: name of local branch)
 */
export async function push(
	repo: Repository,
	remote: string,
	localBranch: string = repo.state.HEAD.name,
	remoteBranch: string = localBranch): Promise<void> {
	const {path: git} = (<any>repo)._repository.repository.git as any;
	const args = ['push', '--porcelain', remote, `${localBranch}:${remoteBranch}`];
	Logger.appendLine(`run> git ${args.join(' ')}`);
	const {stdout, stderr} = await exec(git, args, {
		cwd: repo.rootUri.fsPath,
	});
	Logger.appendLine(stdout);
	Logger.appendLine(stderr);
}
