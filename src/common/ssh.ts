import { parse as parseConfig } from 'ssh-config';
import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import Logger from './logger';

const SSH_URL_REGEXP = /^(?:([^@:]+)@)?([^:/]+):?(.+)$/;
const parse = (url: string): Config => {
	const match = SSH_URL_REGEXP.exec(url);
	if (!match) { return null; }
	const [, User, Host, path] = match;
	return {User, Host, path};
};

const defaultResolver = chainResolvers(
	baseResolver,
	resolverFromConfigFile(),
);

let testResolver = null;
export const _test_setSSHConfig = (config?: string) =>
	testResolver = config
		? chainResolvers(baseResolver, resolverFromConfig(config))
		: null;

export const resolve = (url: string, resolveConfig=testResolver || defaultResolver) => {
	const config = parse(url);
	return config && resolveConfig(config);
};

interface Config {
	Host: string;
	[param: string]: string;
}

type ConfigResolver = (config: Config) => Config;
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
