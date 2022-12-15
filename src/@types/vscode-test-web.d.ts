#!/usr/bin/env node
export declare type BrowserType = 'chromium' | 'firefox' | 'webkit';
export declare type VSCodeVersion = 'insiders' | 'stable' | 'sources';
export interface Options {
    /**
     * Browser to run the test against: 'chromium' | 'firefox' | 'webkit'
     */
    browserType: BrowserType;
    /**
     * Absolute path to folder that contains one or more extensions (in subfolders).
     * Extension folders include a `package.json` extension manifest.
     */
    extensionDevelopmentPath?: string;
    /**
     * Absolute path to the extension tests runner module.
     * Can be either a file path or a directory path that contains an `index.js`.
     * The module is expected to have a `run` function of the following signature:
     *
     * ```ts
     * function run(): Promise<void>;
     * ```
     *
     * When running the extension test, the Extension Development Host will call this function
     * that runs the test suite. This function should throws an error if any test fails.
     */
    extensionTestsPath?: string;
    /**
     * The VS Code version to use. Valid versions are:
     * - `'stable'` : The latest stable build
     * - `'insiders'` : The latest insiders build
     * - `'sources'`: From sources, served at localhost:8080 by running `yarn web` in the vscode repo
     *
     * Currently defaults to `insiders`, which is latest stable insiders.
     */
    version?: VSCodeVersion;
    /**
     * Open the dev tools.
     */
    devTools?: boolean;
    /**
     * Do not show the browser. Defaults to `true` if a extensionTestsPath is provided, `false` otherwise.
     */
    headless?: boolean;
    /**
     * Expose browser debugging on this port number, and wait for the debugger to attach before running tests.
     */
    waitForDebugger?: number;
    /**
     * The folder URI to open VSCode on
     */
    folderUri?: string;
}
/**
 * Runs the tests in a browser.
 *
 * @param options The options defining browser type, extension and test location.
 */
export declare function runTests(options: Options & {
    extensionTestsPath: string;
}): Promise<void>;
export declare function open(options: Options): Promise<void>;
