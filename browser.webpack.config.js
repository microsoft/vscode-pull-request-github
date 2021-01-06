
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
				'node-fetch': 'cross-fetch',
				'vscode-extension-telemetry': path.resolve(__dirname, 'src/env/browser/vscode-extension-telemetry.js'),
				'../env/node/net': path.resolve(__dirname, 'src/env/browser/net'),
				'../env/node/ssh': path.resolve(__dirname, 'src/env/browser/ssh'),
				'./env/node/gitProviders/api': path.resolve(__dirname, 'src/env/browser/gitProviders/api')
			}
		}
	};

	return merge(baseConfig, config);
}

module.exports = function (env) {
	env = env || {};
	env.production = !!env.production;
	return [
		getExtensionConfig(env),
		base.getWebviewConfig(env, './webviews/editorWebview/index.ts', 'webviewIndex.js'),
		base.getWebviewConfig(env, './webviews/activityBarView/index.ts', 'activityBar-webviewIndex.js'),
		base.getWebviewConfig(env, './webviews/createPullRequestView/index.ts', 'createPR-webviewIndex.js')
	];
};