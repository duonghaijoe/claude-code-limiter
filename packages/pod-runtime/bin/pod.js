#!/usr/bin/env node
'use strict';

const { start } = require('../src/index');

const port = parseInt(process.env.PORT, 10) || 4000;
start({ port });
