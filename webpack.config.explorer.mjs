/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { fileURLToPath } from 'node:url';
import { ComponentExplorerPlugin } from '@vscode/component-explorer-webpack-plugin';
import HtmlWebpackPlugin from 'html-webpack-plugin';
import webpack from 'webpack';
import webviewBuild from './webpack.config.js';

const root = fileURLToPath(new URL('./', import.meta.url));

export default async function () {
	const base = await webviewBuild.getWebviewConfig('development', { esbuild: true }, {}, 'tsconfig.explorer.json');
	return {
		...base,
		context: root,
		name: 'component-explorer',
		output: {
			...base.output,
			path: fileURLToPath(new URL('./out/component-explorer', import.meta.url)),
			publicPath: '/',
			filename: 'bundled/[name].js',
			chunkFilename: 'bundled/[name].js',
		},
		module: {
			rules: [{
				oneOf: [
					{ test: /\.css$/, resourceQuery: /inline/, type: 'asset/source' },
					...base.module.rules,
				],
			}],
		},
		plugins: [
			...base.plugins.filter(plugin => !(plugin instanceof webpack.optimize.LimitChunkCountPlugin)),
			new ComponentExplorerPlugin({ include: 'webviews/**/*.fixture.{ts,tsx}' }),
			new HtmlWebpackPlugin({
				filename: '___explorer.html',
				templateContent: '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>GitHub Pull Requests Component Explorer</title><style>html,body,#root{margin:0;height:100%;width:100%}</style></head><body><div id="root"></div></body></html>',
				chunks: ['___explorer'],
			}),
		],
		devServer: {
			host: '127.0.0.1',
			port: 0,
			hot: true,
			static: false,
			client: { overlay: false },
		},
		stats: 'errors-warnings',
	};
}
