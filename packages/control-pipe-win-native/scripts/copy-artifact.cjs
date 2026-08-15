'use strict';

const fs = require('node:fs');
const path = require('node:path');

const source = path.join(__dirname, '..', 'target', 'release', 'lucky_control_pipe_win_native.dll');
const destination = path.join(__dirname, '..', 'lucky_control_pipe_win_native.win32-x64-msvc.node');
fs.copyFileSync(source, destination);
