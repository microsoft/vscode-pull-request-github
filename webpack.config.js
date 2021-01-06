/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//@ts-check

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
		target: 'node',
		resolve: {
			extensions: ['.tsx', '.ts', '.js'],
			alias: {
				"node-fetch": path.resolve(__dirname, 'node_modules/node-fetch/dist/index.cjs'),
			}
		},
		output: {
			filename: '[name].js',
			path: path.resolve(__dirname, 'media'),
			libraryTarget: "commonjs",
			devtoolModuleFilenameTemplate: 'file:///[absolute-resource-path]'
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