//@ts-check

import fs from "fs";
import { defineConfig } from "@vscode/test-cli";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * @param {string} label
 */
function generateConfig(label) {
  const workspaceFolder = join(__dirname, "src", "test", "datascience");
  /** @type {import('@vscode/test-cli').TestConfiguration} */
  let config = {
    label,
    files: ["out/**/*.test.js"],
    version: "insiders",
    srcDir: "src",
    workspaceFolder,
    launchArgs: [
      workspaceFolder,
      "--enable-proposed-api",
      "--disable-extension=GitHub.vscode-pull-request-github-insiders",
    ],
    // env,
    mocha: {
      ui: "tdd",
      color: true,
      timeout: 25000,
      preload: [
        // `${__dirname}/out/platform/ioc/reflectMetadata.js`,
        // `${__dirname}/out/test/common.test.require.js`
      ],
    },
  };

  return config;
}


export default defineConfig(generateConfig("Local Tests"));
