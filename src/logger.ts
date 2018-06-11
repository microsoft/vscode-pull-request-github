import { window, OutputChannel } from 'vscode';

const Logger: OutputChannel = window.createOutputChannel('GitHub Pull Request');
export default Logger;