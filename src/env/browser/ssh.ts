/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { parse as parseConfig } from 'ssh-config';

export const resolve = (_url: string) => undefined;

export function baseResolver(config: Config) {
	return {
		...config,
		Hostname: config.Host,
	};
}

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

export function chainResolvers(...chain: (ConfigResolver | undefined)[]): ConfigResolver {
	const resolvers = chain.filter(x => !!x) as ConfigResolver[];
	return (config: Config) =>
		resolvers.reduce(
			(resolved, next) => ({
				...resolved,
				...next(resolved),
			}),
			config,
		);
}

export function resolverFromConfig(text: string): ConfigResolver {
	const config = parseConfig(text);
	return h => config.compute(h.Host);
}

export class Resolvers {
	static default = baseResolver;

	static fromConfig(conf: string) {
		return chainResolvers(baseResolver, resolverFromConfig(conf));
	}

	static current = Resolvers.default;
}
