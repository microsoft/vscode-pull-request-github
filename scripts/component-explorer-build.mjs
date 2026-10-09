/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import webpack from 'webpack';
import createConfig from '../webpack.config.explorer.mjs';

const compiler = webpack(await createConfig());
await new Promise((resolve, reject) => {
	compiler.run((error, stats) => compiler.close(closeError => {
		if (error || closeError) {
			reject(error ?? closeError);
		} else if (stats.hasErrors()) {
			reject(new Error(stats.toString('errors-warnings')));
		} else {
			process.stdout.write(stats.toString('errors-warnings') + '\n');
			resolve();
		}
	}));
});
