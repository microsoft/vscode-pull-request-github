const path = require('path');
const webpack = require('webpack');
const TSLintPlugin = require('tslint-webpack-plugin');
const TerserPlugin = require('terser-webpack-plugin');

function getWebviewConfig(env, entry, outputFilename) {
	/** @type webpack.Configuration */
	let webview = {
		name: outputFilename,
		mode: env.production ? 'production' : 'development',
		entry: {
			index: entry
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
			filename: outputFilename,
			path: path.resolve(__dirname, 'media')
		},
		plugins: [
			new webpack.IgnorePlugin(/^\.\/locale$/, /moment$/),
			new TSLintPlugin({
				files: ['./src/**/*.ts']
			})
		],
		optimization: {
			minimizer: [
				new TerserPlugin({
					extractComments: false,
					terserOptions: {
						keep_classnames: /^AbortSignal$/,
					},
				})
			]
		}
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
				},
				{
					test: /webviewIndex\.js/,
					use: 'raw-loader'
				}
			]
		},
		resolve: {
			extensions: ['.tsx', '.ts', '.js'],
		},
		devtool: !env.production ? 'source-map' : undefined,
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

module.exports.getExtensionConfig = getExtensionConfig;
module.exports.getWebviewConfig = getWebviewConfig;