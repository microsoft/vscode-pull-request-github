
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
				'node-fetch': path.resolve(__dirname, 'node_modules/node-fetch/browser.js'),
				'vscode-extension-telemetry': path.resolve(__dirname, 'src/env/browser/vscode-extension-telemetry.js'),
				'../env/node/net': path.resolve(__dirname, 'src/env/browser/net'),
				'../env/node/ssh': path.resolve(__dirname, 'src/env/browser/ssh')
			}
		}
	};

	return merge(baseConfig, config);;
}

module.exports = function (env) {
	env = env || {};
	env.production = !!env.production;
	return [getExtensionConfig(env), base.getWebviewConfig(env)];
};