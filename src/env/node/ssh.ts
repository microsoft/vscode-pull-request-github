/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import Logger from '../../common/logger';
import { baseResolver, chainResolvers, ConfigResolver, resolverFromConfig, sshParse } from '../browser/ssh';

export class Resolvers {
	static default = chainResolvers(baseResolver, resolverFromConfigFile());

	static fromConfig(conf: string) {
		return chainResolvers(baseResolver, resolverFromConfig(conf));
	}

	static current = Resolvers.default;
}

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
	const config = sshParse(url);
	return config && resolveConfig(config);
};

function resolverFromConfigFile(configPath = join(homedir(), '.ssh', 'config')): ConfigResolver | undefined {
	try {
		const config = readFileSync(configPath).toString();
		return resolverFromConfig(config);
	} catch (error) {
		Logger.warn(`${configPath}: ${error.message}`);
	}
}
