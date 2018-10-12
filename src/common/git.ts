import { Repository } from '../typings/git';

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
	const self = (<any>repo)._repository as any;
	return self.run(['push', remote, `${localBranch}:${remoteBranch}`]);
}

// async pull(rebase?: boolean, remote?: string, branch?: string): Promise<void> {
// 	const args = ['pull', '--tags'];

// 	if (rebase) {
// 		args.push('-r');
// 	}

// 	if (remote && branch) {
// 		args.push(remote);
// 		args.push(branch);
// 	}

// 	try {
// 		await this.run(args);
// 	} catch (err) {
// 		if (/^CONFLICT \([^)]+\): \b/m.test(err.stdout || '')) {
// 			err.gitErrorCode = GitErrorCodes.Conflict;
// 		} else if (/Please tell me who you are\./.test(err.stderr || '')) {
// 			err.gitErrorCode = GitErrorCodes.NoUserNameConfigured;
// 		} else if (/Could not read from remote repository/.test(err.stderr || '')) {
// 			err.gitErrorCode = GitErrorCodes.RemoteConnectionError;
// 		} else if (/Pull is not possible because you have unmerged files|Cannot pull with rebase: You have unstaged changes|Your local changes to the following files would be overwritten|Please, commit your changes before you can merge/i.test(err.stderr)) {
// 			err.stderr = err.stderr.replace(/Cannot pull with rebase: You have unstaged changes/i, 'Cannot pull with rebase, you have unstaged changes');
// 			err.gitErrorCode = GitErrorCodes.DirtyWorkTree;
// 		} else if (/cannot lock ref|unable to update local ref/i.test(err.stderr || '')) {
// 			err.gitErrorCode = GitErrorCodes.CantLockRef;
// 		} else if (/cannot rebase onto multiple branches/i.test(err.stderr || '')) {
// 			err.gitErrorCode = GitErrorCodes.CantRebaseMultipleBranches;
// 		}

// 		throw err;
// 	}
// }
