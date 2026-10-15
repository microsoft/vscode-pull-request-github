/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import WebpackDevServer from 'webpack-dev-server';
import webpack from 'webpack';
import createConfig from '../webpack.config.explorer.mjs';

const compiler = webpack(await createConfig());
const server = new WebpackDevServer(compiler.options.devServer, compiler);
await server.start();
const address = server.server.address();
if (!address || typeof address === 'string') {
	throw new Error('Component Explorer did not bind a TCP port.');
}
process.stdout.write(`Component Explorer listening at http://127.0.0.1:${address.port}/___explorer\n`);
