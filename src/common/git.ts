import * as iconv from 'iconv-lite';
import { execFile } from 'child_process';

const gitInfo = {
	path: null
};

export interface IGitResult {
	/** The standard output from git. */
	readonly stdout: string;
	/** The standard error output from git. */
	readonly stderr: string;
	/** The exit code of the git process. */
	readonly exitCode: number;
}

export interface IGitExecutionOptions {
	readonly cwd?: string;
	readonly env?: Object;
	readonly encoding?: BufferEncoding;
	readonly maxBuffer?: number;
	readonly stdin?: string | Buffer;
	readonly stdinEncoding?: string;
}

export function setGitPath(path: string) {
	gitInfo.path = path;
}

export async function exec(args: any[], options: IGitExecutionOptions): Promise<IGitResult> {
	const encoding = options.encoding || 'utf8';
	const runOpts = {
		...options,
		encoding: encoding === 'utf8' ? 'utf8' : 'binary',
		env: { ...(options.env || process.env) }
	} as IGitExecutionOptions;

	args.splice(0, 0, '-c', 'core.quotepath=false', '-c', 'color.ui=false');
	let data: IGitResult;
	try {
		data = await run(gitInfo.path, args, encoding, runOpts);
	} catch (ex) {
	}

	return data;
}

export function run(command: string, args: any[], encoding: string, options: IGitExecutionOptions = {}) {
	const { stdin, stdinEncoding, ...opts } = { maxBuffer: 10 * 1024 * 1024, ...options } as IGitExecutionOptions;

	return new Promise<IGitResult>((resolve, reject) => {
		const proc = execFile(
			command,
			args,
			opts,
			(err: Error & { code?: string | number } | null, stdout, stderr) => {
				let data = stdout;
				if (!err) {
					if (encoding !== 'utf8' && encoding !== 'binary') {
						data = iconv.decode(Buffer.from(stdout, 'binary'), encoding);
					}
				}

				resolve({
					stdout: data,
					stderr: stderr,
					exitCode: err && err.code ? Number(err.code) : 0
				});
			}
		);

		if (stdin) {
			proc.stdin.end(stdin, stdinEncoding || 'utf8');
		}
	});
}
