
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//@ts-check

'use strict';

const path = require('path');
const webpack = require('webpack');
const base = require('./base.webpack.config.js');
const merge = require('merge-options');

/**
 *
 * @param {*} env
 * @returns webpack.Configuration
 */
function getExtensionConfig(env) {
	const baseConfig = base.getExtensionConfig(env);

	/** @type webpack.Configuration */
	const config = {
		entry: {
			extension: './src/extensionWeb.ts'
		},
		target: 'webworker',
		node: {
			path: true
		},
		output: {
			filename: '[name].js',
			path: path.join(__dirname, 'dist', 'browser'),
			libraryTarget: 'commonjs',
		},
		resolve: {
			alias: {
				'vscode-extension-telemetry': path.resolve(__dirname, 'src/env/browser/vscode-extension-telemetry.js'),
				'../env/node/net': path.resolve(__dirname, 'src/env/browser/net'),
				'../env/node/ssh': path.resolve(__dirname, 'src/env/browser/ssh')
			}
		}
	};

	return merge(baseConfig, config);
}

module.exports = function (env) {
	env = env || {};
	env.production = !!env.production;
	return [getExtensionConfig(env), base.getWebviewConfig(env)];
};