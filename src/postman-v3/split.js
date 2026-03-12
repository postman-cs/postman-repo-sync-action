#!/usr/bin/env node

/**
 * Split v3 collections into multi-file folder structure
 * Reads v3 collection JSON/YAML and splits into directory-based structure
 * per the multi-file spec draft
 */

import { readFile, writeFile, mkdir, readdir, stat } from 'fs/promises';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import { sanitizeName } from './utils/name-utils.js';
import {
  convertScriptCodeArrayToBlockScalar,
  YAML_DUMP_OPTIONS
} from './utils/yaml-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');
const v3ExamplesDir = join(rootDir, 'examples', 'v3');

// Supported request types
const REQUEST_TYPES = new Set([
  'http',
  'grpc',
  'graphql',
  'websocket',
  'socketio',
  'mqtt',
  'mcp',
  'llm'
]);

/**
 * Check if a string should be converted to a YAML block scalar
 */
function shouldUseBlockScalar(str) {
  if (typeof str !== 'string') {
    return false;
  }
  // Use block scalar for strings longer than 100 chars or containing newlines
  return str.length > 100 || str.includes('\n');
}

/**
 * Check if a value should be included (not empty/null/undefined)
 */
function shouldInclude(value) {
  if (value === null || value === undefined) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (typeof value === 'string') {
    return value.trim().length > 0;
  }
  if (typeof value === 'object') {
    return Object.keys(value).length > 0;
  }
  return true;
}

/**
 * Check if body has meaningful content
 */
function hasBodyContent(body) {
  if (!body) return false;

  if (body.type === 'urlencoded' || body.type === 'formdata') {
    return Array.isArray(body.content) && body.content.length > 0;
  }
  if (body.type === 'file') {
    return body.content && body.content.src;
  }
  if (body.type === 'none') {
    return false;
  }
  // For text/json/xml/html/javascript, content is a string
  return (
    body.content &&
    typeof body.content === 'string' &&
    body.content.trim().length > 0
  );
}

/**
 * Check if auth should be included (not noauth)
 */
function shouldIncludeAuth(auth) {
  if (!auth) return false;
  if (Array.isArray(auth)) {
    return auth.length > 0;
  }
  return auth.type !== 'noauth';
}

/**
 * Process scripts for YAML output
 */
function processScripts(scripts) {
  if (!shouldInclude(scripts)) {
    return undefined;
  }

  return scripts.map((script) => {
    const scriptObj = {
      type: script.type,
      code: script.code
    };
    if (script.language) {
      scriptObj.language = script.language;
    }
    if (script.packages) {
      scriptObj.packages = script.packages;
    }
    // Only include requests if it has properties (not empty object)
    if (script.requests && Object.keys(script.requests).length > 0) {
      scriptObj.requests = script.requests;
    }
    return scriptObj;
  });
}

/**
 * Protocol-specific field handlers
 */
const PROTOCOL_FIELDS = {
  http: ['method', 'queryParams', 'pathVariables'],
  grpc: ['methodPath', 'methodDescriptor', 'message', 'metadata'],
  graphql: ['query', 'variables', 'schema'],
  websocket: ['queryParams', 'messages'],
  socketio: ['queryParams', 'events', 'messages'],
  mqtt: ['clientId', 'version', 'topics', 'lastWill', 'properties', 'messages'],
  mcp: ['transport', 'command', 'env', 'message'],
  llm: ['config', 'userPrompts', 'systemPrompts', 'mcpConfig', 'enabledTools']
};

/**
 * Add protocol-specific fields to YAML object
 */
function addProtocolFields(request, yamlObj) {
  const requestType = request.type || 'http';
  const fields = PROTOCOL_FIELDS[requestType] || [];

  for (const field of fields) {
    const value = request[field];

    // Special handling for conditional fields
    if (field === 'queryParams' || field === 'pathVariables') {
      if (requestType === 'http' && shouldInclude(value)) {
        yamlObj[field] = value;
      } else if (
        (requestType === 'websocket' || requestType === 'socketio') &&
        shouldInclude(value)
      ) {
        yamlObj[field] = value;
      }
    } else if (field === 'message' && requestType === 'mcp') {
      // MCP message is a string
      if (shouldInclude(value)) {
        yamlObj[field] = value;
      }
    } else if (field === 'version' && requestType === 'mqtt') {
      // MQTT version can be 0, so check for undefined
      if (value !== undefined) {
        yamlObj[field] = value;
      }
    } else if (Array.isArray(value)) {
      if (shouldInclude(value)) {
        yamlObj[field] = value;
      }
    } else if (typeof value === 'object' && value !== null) {
      if (shouldInclude(value)) {
        yamlObj[field] = value;
      }
    } else if (value !== undefined && value !== null) {
      yamlObj[field] = value;
    }
  }
}

/**
 * Convert request to YAML format for request.yaml
 */
function requestToYaml(request) {
  const yamlObj = {
    type: request.type || 'http',
    name: request.name
  };

  // Common fields
  if (request.url) {
    yamlObj.url = request.url;
  }

  if (request.method) {
    yamlObj.method = request.method;
  }

  if (shouldInclude(request.headers)) {
    yamlObj.headers = request.headers;
  }

  // Protocol-specific fields
  addProtocolFields(request, yamlObj);

  // Body
  if (hasBodyContent(request.body)) {
    yamlObj.body = request.body;
  }

  // Auth
  if (shouldIncludeAuth(request.auth)) {
    yamlObj.auth = request.auth;
  }

  // Settings
  if (request.settings) {
    yamlObj.settings = request.settings;
  }

  // Scripts
  const scripts = processScripts(request.scripts);
  if (scripts) {
    yamlObj.scripts = scripts;
  }

  // Examples
  if (shouldInclude(request.examples)) {
    yamlObj.examples = request.examples;
  }

  // Description
  if (shouldInclude(request.description)) {
    yamlObj.description = request.description;
  }

  // ID
  if (request.id) {
    yamlObj.id = request.id;
  }

  return yamlObj;
}

/**
 * Post-process YAML string to convert long escaped strings to block scalars
 * This finds content fields that are long or contain newlines and converts them
 */
function convertContentToBlockScalar(yamlStr) {
  // Match content fields with escaped strings
  // js-yaml typically puts escaped strings on a single line, but we handle both cases
  // Pattern: (indent)content: "escaped string with \n and \t"
  return yamlStr.replace(
    /^(\s+)(content:\s+)"((?:[^"\\]|\\.)*)"$/gm,
    (match, indent, key, escapedContent) => {
      // Check if the escaped content looks like JSON before unescaping
      // This helps us detect JSON content that might have escape sequences
      const looksLikeJson =
        escapedContent.trim().startsWith('{') ||
        escapedContent.trim().startsWith('[');

      // For JSON content, check if it contains escape sequences that would break in block scalars
      // Pattern: "..." followed by \\n, \\t, etc. (escaped backslash + escape char in JSON)
      if (
        looksLikeJson &&
        /"([^"]*\\(?:\\[nrtbfu]|u[0-9a-fA-F]{4}))/g.test(escapedContent)
      ) {
        // Keep as quoted string to preserve JSON escape sequences
        // Converting to block scalar would turn "\\n" into a literal newline, breaking JSON
        return match;
      }

      // Unescape the string
      let unescaped;
      try {
        // Use JSON.parse to properly unescape all escape sequences
        unescaped = JSON.parse(`"${escapedContent}"`);
      } catch (e) {
        // Fallback to manual unescaping for common cases
        unescaped = escapedContent
          .replace(/\\n/g, '\n')
          .replace(/\\t/g, '\t')
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, '\\')
          .replace(/\\r/g, '\r');
      }

      // Convert to block scalar if it's long or contains newlines
      if (shouldUseBlockScalar(unescaped)) {
        const contentLines = unescaped.split('\n');
        // Use literal block scalar (|) to preserve newlines exactly
        const blockScalar = `${indent}${key}|\n${contentLines.map((line) => `${indent}  ${line}`).join('\n')}`;
        return blockScalar;
      }

      // Keep as-is if it's short
      return match;
    }
  );
}

/**
 * Process a request item - create request.yaml file
 */
async function processRequest(request, parentDir, usedNames = new Set()) {
  let sanitizedName = sanitizeName(request.name);
  let fileName = `${sanitizedName}.request.yaml`;
  let counter = 1;

  // Handle duplicate names by appending a counter
  while (usedNames.has(fileName)) {
    fileName = `${sanitizedName}_${counter}.request.yaml`;
    counter++;
  }
  usedNames.add(fileName);

  const filePath = join(parentDir, fileName);
  const yamlObj = requestToYaml(request);

  // Dump to YAML
  let yamlContent = yaml.dump(yamlObj, YAML_DUMP_OPTIONS);

  // Post-process: convert long escaped content strings to block scalars
  yamlContent = convertContentToBlockScalar(yamlContent);

  // Post-process: convert script code arrays to block scalars
  yamlContent = convertScriptCodeArrayToBlockScalar(yamlContent);

  await writeFile(filePath, yamlContent, 'utf-8');
  return fileName;
}

/**
 * Create base YAML object for folder/collection
 */
function createBaseYaml(item, itemType) {
  const yamlObj = {
    type: itemType,
    name: item.name
  };

  if (shouldInclude(item.description)) {
    yamlObj.description = item.description;
  }

  if (item.id) {
    yamlObj.id = item.id;
  }

  if (shouldInclude(item.variables)) {
    yamlObj.variables = item.variables;
  }

  if (shouldIncludeAuth(item.auth)) {
    yamlObj.auth = item.auth;
  }

  const scripts = processScripts(item.scripts);
  if (scripts) {
    yamlObj.scripts = scripts;
  }

  return yamlObj;
}

/**
 * Process items in a folder/collection and create references
 */
async function processItems(items, parentDir, usedNames = new Set()) {
  const itemRefs = [];

  if (!shouldInclude(items)) {
    return itemRefs;
  }

  for (const item of items) {
    if (item.type === 'folder') {
      let folderName = sanitizeName(item.name);
      let folderRef = `./${folderName}/folder.yaml`;
      let counter = 1;

      // Handle duplicate folder names
      while (usedNames.has(folderRef)) {
        folderRef = `./${folderName}_${counter}/folder.yaml`;
        counter++;
      }
      usedNames.add(folderRef);

      // Update folder name if we had to add a counter
      if (counter > 1) {
        folderName = `${folderName}_${counter - 1}`;
      }

      await processFolder(item, parentDir, folderName);
      itemRefs.push({ ref: folderRef });
    } else if (REQUEST_TYPES.has(item.type)) {
      const fileName = await processRequest(item, parentDir, usedNames);
      itemRefs.push({ ref: `./${fileName}` });
    }
  }

  return itemRefs;
}

/**
 * Process a folder item - create folder directory and folder.yaml
 */
async function processFolder(folder, parentDir, folderName = null) {
  const sanitizedName = folderName || sanitizeName(folder.name);
  const folderDir = join(parentDir, sanitizedName);
  await mkdir(folderDir, { recursive: true });

  // Create folder.yaml
  const folderYaml = createBaseYaml(folder, 'folder');

  // Process items
  const usedNames = new Set();
  const items = await processItems(folder.items, folderDir, usedNames);
  if (items.length > 0) {
    folderYaml.items = items;
  }

  // Write folder.yaml
  const folderYamlPath = join(folderDir, 'folder.yaml');
  let yamlContent = yaml.dump(folderYaml, YAML_DUMP_OPTIONS);

  // Post-process: convert script code arrays to block scalars
  yamlContent = convertScriptCodeArrayToBlockScalar(yamlContent);

  await writeFile(folderYamlPath, yamlContent, 'utf-8');

  return sanitizedName;
}

/**
 * Read collection file (JSON or YAML)
 */
async function readCollection(collectionDir) {
  const collectionJsonPath = join(collectionDir, '_collection.json');
  const collectionYamlPath = join(collectionDir, '_collection.yaml');

  try {
    const content = await readFile(collectionJsonPath, 'utf-8');
    return JSON.parse(content);
  } catch (e) {
    try {
      const content = await readFile(collectionYamlPath, 'utf-8');
      return yaml.load(content);
    } catch (e2) {
      return null;
    }
  }
}

/**
 * Split a collection into multi-file structure
 */
async function splitCollection(collectionDir) {
  const collection = await readCollection(collectionDir);

  if (!collection) {
    console.log(
      `   ⚠️  No _collection.json or _collection.yaml found, skipping`
    );
    return;
  }

  // Create collection.yaml (root descriptor)
  const collectionYaml = {
    $schema: collection.$schema,
    ...createBaseYaml(collection, 'collection')
  };

  // Process items
  const usedNames = new Set();
  const items = await processItems(collection.items, collectionDir, usedNames);
  if (items.length > 0) {
    collectionYaml.items = items;
  }

  // Write collection.yaml
  const newCollectionYamlPath = join(collectionDir, 'collection.yaml');
  let yamlContent = yaml.dump(collectionYaml, YAML_DUMP_OPTIONS);

  // Post-process: convert script code arrays to block scalars
  yamlContent = convertScriptCodeArrayToBlockScalar(yamlContent);

  await writeFile(newCollectionYamlPath, yamlContent, 'utf-8');
}

/**
 * Main function
 */
async function splitExamples() {
  try {
    // Check if v3 directory exists
    try {
      await stat(v3ExamplesDir);
    } catch (error) {
      console.log('⚠️  examples/v3/ directory not found');
      console.log('   Run "npm run examples:convert" first');
      return;
    }

    // Find all collection directories
    const entries = await readdir(v3ExamplesDir, { withFileTypes: true });
    const collectionDirs = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(v3ExamplesDir, entry.name));

    if (collectionDirs.length === 0) {
      console.log('⚠️  No collection directories found in examples/v3/');
      return;
    }

    console.log(`📁 Splitting ${collectionDirs.length} collection(s)...`);

    for (const collectionDir of collectionDirs) {
      const collectionName = basename(collectionDir);
      try {
        await splitCollection(collectionDir);
        console.log(`  ✓ ${collectionName}`);
      } catch (error) {
        console.log(`  ❌ ${collectionName}: ${error.message}`);
      }
    }

    console.log(`✅ Split ${collectionDirs.length} collection(s)`);
  } catch (error) {
    console.error('❌ Error:', error.message);
    if (error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

splitExamples();
