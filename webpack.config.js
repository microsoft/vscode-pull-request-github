/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//@ts-check

const path = require('path');
const webpack = require('webpack');
const TSLintPlugin = require('tslint-webpack-plugin');

function getWebviewConfig(env) {
	/** @type webpack.Configuration */
	let webview = {
		name: 'webview',
		mode: env.production ? 'production' : 'development',
		entry: {
			index: './preview-src/index.ts'
		},
		module: {
			rules: [
				{
					test: /\.tsx?$/,
					use: 'ts-loader',
					exclude: /node_modules/
				},
				{
					test: /\.css/,
					use: ['style-loader', 'css-loader']
				},
				{
					test: /\.svg/,
					use: ['svg-inline-loader']
				}
			]
		},
		resolve: {
			extensions: ['.tsx', '.ts', '.js', '.svg']
		},
		devtool: !env.production ? 'inline-source-map' : undefined,
		output: {
			filename: '[name].js',
			path: path.resolve(__dirname, 'media')
		},
		plugins: [
			new webpack.IgnorePlugin(/^\.\/locale$/, /moment$/),
			new TSLintPlugin({
				files: ['./src/**/*.ts']
			})
		]
	};

	return webview;
}

/**
 *
 * @param {*} env
 * @returns webpack.Configuration
 */
function getExtensionConfig(env) {
	/** @type webpack.Configuration */
	let config = {
		name: 'extension',
		mode: env.production ? 'production' : 'development',
		target: 'node',
		entry: {
			extension: './src/extension.ts'
		},
		module: {
			rules: [
				{
					test: /\.tsx?$/,
					use: 'ts-loader',
					exclude: /node_modules/
				},
				// FIXME: apollo-client uses .mjs, which imposes hard restrictions
				// on imports available from other callers. They probably didn't know
				// this. They just used .mjs because it seemed new and hip.
				//
				// We should either fix or remove that package, then remove this rule,
				// which introduces nonstandard behavior for mjs files, which are
				// terrible. This is all terrible. Everything is terrible.👇🏾
				{
					test: /\.mjs$/,
					include: /node_modules/,
					type: "javascript/auto",
				},
				{
					test: /\.gql/,
					loader: 'graphql-tag/loader',
					exclude: /node_modules/
				}
			]
		},
		resolve: {
			extensions: ['.tsx', '.ts', '.js'],
			alias: {
				"node-fetch": path.resolve(__dirname, 'node_modules/node-fetch/dist/index.cjs'),
			}
		},
		devtool: !env.production ? 'source-map' : undefined,
		output: {
			filename: '[name].js',
			path: path.resolve(__dirname, 'media'),
			libraryTarget: "commonjs",
			devtoolModuleFilenameTemplate: 'file:///[absolute-resource-path]'
		},
		externals: {
			'vscode': 'commonjs vscode',
			'utf-8-validate': 'utf-8-validate',
			'bufferutil': 'bufferutil',
			'encoding': 'encoding',
			'applicationinsights-native-metrics': 'applicationinsights-native-metrics'
		}
	};

	return config;
}

module.exports = function (env) {
	env = env || {};
	env.production = !!env.production;
	return [getExtensionConfig(env), getWebviewConfig(env)];
};