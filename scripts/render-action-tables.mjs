#!/usr/bin/env node
// Renders the Inputs and Outputs tables in README.md from action.yml.
// Usage: node scripts/render-action-tables.mjs [--check]

import { readFileSync, writeFileSync } from 'node:fs';
import { argv, exit } from 'node:process';
import { error as logError } from 'node:console';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const actionPath = resolve(repoRoot, 'action.yml');
const readmePath = resolve(repoRoot, 'README.md');

const action = parse(readFileSync(actionPath, 'utf8'));

function cell(value) {
  if (value === undefined || value === null || value === '') {
    return '';
  }
  return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

function renderInputs(inputs) {
  const lines = [
    '| Name | Description | Required | Default |',
    '| --- | --- | --- | --- |'
  ];
  for (const [name, def] of Object.entries(inputs)) {
    const required = def.required === true ? 'yes' : 'no';
    const fallback = def.default === undefined ? '' : `\`${cell(def.default) === '' ? '""' : cell(def.default)}\``;
    lines.push(`| \`${name}\` | ${cell(def.description)} | ${required} | ${fallback} |`);
  }
  return lines.join('\n');
}

function renderOutputs(outputs) {
  const lines = ['| Name | Description |', '| --- | --- |'];
  for (const [name, def] of Object.entries(outputs)) {
    lines.push(`| \`${name}\` | ${cell(def.description)} |`);
  }
  return lines.join('\n');
}

function replaceBlock(content, marker, table) {
  const start = `<!-- ${marker}:start -->`;
  const end = `<!-- ${marker}:end -->`;
  const startIdx = content.indexOf(start);
  const endIdx = content.indexOf(end);
  if (startIdx === -1 || endIdx === -1) {
    throw new Error(`README.md is missing ${start} / ${end} markers`);
  }
  return (
    content.slice(0, startIdx + start.length) +
    '\n' +
    table +
    '\n' +
    content.slice(endIdx)
  );
}

const current = readFileSync(readmePath, 'utf8');
let next = replaceBlock(current, 'inputs-table', renderInputs(action.inputs ?? {}));
next = replaceBlock(next, 'outputs-table', renderOutputs(action.outputs ?? {}));

if (argv.includes('--check')) {
  if (next !== current) {
    logError('README tables are out of date. Run: npm run docs:tables');
    exit(1);
  }
  logError('README tables are up to date.');
} else if (next !== current) {
  writeFileSync(readmePath, next);
  logError('README tables updated.');
} else {
  logError('README tables already up to date.');
}
