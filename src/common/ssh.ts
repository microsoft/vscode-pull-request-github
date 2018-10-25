import { parse as parseConfig } from 'ssh-config';
import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import Logger from './logger';

const SSH_URL_RE = /^(?:([^@:]+)@)?([^:/]+):?(.+)$/;
const URL_SCHEME_RE = /^([a-z-]+):\/\//;

/**
 * SSH Config interface
 *
 * Note that this interface atypically-capitalized field names. This is for consistency
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
export const resolve = (url: string, resolveConfig=testResolver || defaultResolver) => {
	const config = parse(url);
	return config && resolveConfig(config);
};

let testResolver = null;
export const _test_setSSHConfig = (config?: string) =>
	testResolver = config
		? chainResolvers(baseResolver, resolverFromConfig(config))
		: null;

const parse = (url: string): Config | null => {
	const urlMatch = URL_SCHEME_RE.exec(url);
	if (urlMatch) {
		const [fullSchemePrefix, scheme] = urlMatch;
		if (scheme === 'ssh') {
			url = url.slice(fullSchemePrefix.length);
		} else {
			return null;
		}
	}
	const match = SSH_URL_RE.exec(url);
	if (!match) { return null; }
	const [, User, Host, path] = match;
	return {User, Host, path};
};

const defaultResolver = chainResolvers(
	baseResolver,
	resolverFromConfigFile(),
);

function baseResolver(config: Config) {
	return {
		...config,
		HostName: config.Host,
	};
}

function resolverFromConfigFile(configPath=join(homedir(), '.ssh', 'config')): ConfigResolver {
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

function chainResolvers(...chain: ConfigResolver[]): ConfigResolver {
	const resolvers = chain.filter(x => !!x);
	return  (config: Config) => resolvers
		.reduce((resolved, next) => ({
			...resolved,
			...next(resolved),
		}), config);
}
