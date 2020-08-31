import { parse as parseConfig } from 'ssh-config';
import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import Logger from '../../common/logger';

const SSH_URL_RE = /^(?:([^@:]+)@)?([^:/]+):?(.+)$/;
const URL_SCHEME_RE = /^([a-z-]+):\/\//;

/**
 * SSH Config interface
 *
 * Note that this interface atypically capitalizes field names. This is for consistency
 * with SSH config files.
 */
export interface Config {
	Host: string;
	[param: string]: string;
}

/**
 * ConfigResolvers take a config, resolve some additional data (perhaps using
 * a config file), and return a new Config.
 */
export type ConfigResolver = (config: Config) => Config;

/**
 * Parse and resolve an SSH url. Resolves host aliases using the configuration
 * specified by ~/.ssh/config, if present.
 *
 * Examples:
 *
 *    resolve("git@github.com:Microsoft/vscode")
 *      {
 *        Host: 'github.com',
 *        HostName: 'github.com',
 *        User: 'git',
 *        path: 'Microsoft/vscode',
 *      }
 *
 *    resolve("hub:queerviolet/vscode", resolverFromConfig("Host hub\n  HostName github.com\n  User git\n"))
 *      {
 *        Host: 'hub',
 *        HostName: 'github.com',
 *        User: 'git',
 *        path: 'queerviolet/vscode',
 *      }
 *
 * @param {string} url the url to parse
 * @param {ConfigResolver?} resolveConfig ssh config resolver (default: from ~/.ssh/config)
 * @returns {Config}
 */
export const resolve = (url: string, resolveConfig = Resolvers.current) => {
	const config = parse(url);
	return config && resolveConfig(config);
};

export class Resolvers {
	static default = chainResolvers(
		baseResolver,
		resolverFromConfigFile(),
	);

	static fromConfig(conf: string) {
		return chainResolvers(baseResolver, resolverFromConfig(conf));
	}

	static current = Resolvers.default;
}

const parse = (url: string): Config | undefined => {
	const urlMatch = URL_SCHEME_RE.exec(url);
	if (urlMatch) {
		const [fullSchemePrefix, scheme] = urlMatch;
		if (scheme === 'ssh') {
			url = url.slice(fullSchemePrefix.length);
		} else {
			return;
		}
	}
	const match = SSH_URL_RE.exec(url);
	if (!match) { return; }
	const [, User, Host, path] = match;
	return { User, Host, path };
};

function baseResolver(config: Config) {
	return {
		...config,
		Hostname: config.Host,
	};
}

function resolverFromConfigFile(configPath = join(homedir(), '.ssh', 'config')): ConfigResolver | undefined {
	try {
		const config = readFileSync(configPath).toString();
		return resolverFromConfig(config);
	} catch (error) {
		Logger.appendLine(`${configPath}: ${error.message}`);
	}
}

export function resolverFromConfig(text: string): ConfigResolver {
	const config = parseConfig(text);
	return h => config.compute(h.Host);
}

function chainResolvers(...chain: (ConfigResolver | undefined)[]): ConfigResolver {
	const resolvers = chain.filter(x => !!x) as ConfigResolver[];
	return (config: Config) => resolvers
		.reduce((resolved, next) => ({
			...resolved,
			...next(resolved),
		}), config);
}
