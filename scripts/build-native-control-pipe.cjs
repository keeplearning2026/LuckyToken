'use strict';

const { spawnSync } = require('node:child_process');

if (process.platform !== 'win32' || process.arch !== 'x64') process.exit(0);

const npmCli = process.env.npm_execpath;
if (npmCli === undefined) throw new Error('npm_execpath is required');
const result = spawnSync(process.execPath, [
  npmCli,
  'run',
  'build',
  '--workspace',
  '@luckytoken/control-pipe-win-native',
], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
