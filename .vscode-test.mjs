
import { defineConfig } from "@vscode/test-cli";

/**
 * @param {string} label
 */
function generateConfig(label) {
  /** @type {import('@vscode/test-cli').TestConfiguration} */
  let config = {
    label,
    files: ["out/**/*.test.js"],
    version: "insiders",
    srcDir: "src",
    launchArgs: [
      "--enable-proposed-api",
      "--disable-extension=GitHub.vscode-pull-request-github-insiders",
    ],
    // env,
    mocha: {
      ui: "bdd",
      color: true,
      timeout: 25000
    },
  };

  return config;
}

export default defineConfig(generateConfig("Local Tests"));
