/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export function resolveGitUrlAlias(url: string, configs: readonly { key: string; value: string }[]): string {
	const substitutions = configs.flatMap(config => {
		const match = /^url\.(?<replacement>.+)\.insteadof$/i.exec(config.key);
		return match?.groups ? [{ prefix: config.value, replacement: match.groups.replacement }] : [];
	}).sort((left, right) => right.prefix.length - left.prefix.length);
	const substitution = substitutions.find(candidate => url.startsWith(candidate.prefix));
	return substitution ? substitution.replacement + url.slice(substitution.prefix.length) : url;
}
