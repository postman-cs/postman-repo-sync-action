#!/usr/bin/env node

/**
 * Convert v2 collections to v3 format
 * Reads Postman v2 collection JSON files from examples/v2
 * Transforms them to v3 format and outputs JSON and YAML in examples/v3
 */

import { readFile, writeFile, mkdir, readdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');
const v2Dir = join(rootDir, 'examples', 'v2');
const v3Dir = join(rootDir, 'examples', 'v3');

/**
 * Transform v2 auth to v3 auth format
 */
function transformAuth(v2Auth) {
  if (!v2Auth || !v2Auth.type) {
    return { type: 'noauth' };
  }

  const authTypeMap = {
    apikey: 'apikey',
    awsv4: 'awsv4',
    basic: 'basic',
    bearer: 'bearer',
    digest: 'digest',
    edgegrid: 'edgegrid',
    hawk: 'hawk',
    jwt: 'jwt',
    noauth: 'noauth',
    oauth1: 'oauth1',
    oauth2: 'oauth2',
    ntlm: 'ntlm',
    asap: 'asap'
  };

  const type = authTypeMap[v2Auth.type] || 'noauth';

  const credentials = [];

  // Transform auth-specific fields to credentials array
  // All auth types use the same structure, so we can iterate
  const authFields = [
    'apikey',
    'basic',
    'bearer',
    'oauth1',
    'oauth2',
    'ntlm',
    'digest',
    'hawk',
    'awsv4',
    'jwt',
    'asap',
    'edgegrid'
  ];
  for (const field of authFields) {
    if (v2Auth[field] && Array.isArray(v2Auth[field])) {
      v2Auth[field].forEach((item) => {
        if (item.key && item.value !== undefined) {
          credentials.push({ key: item.key, value: item.value });
        }
      });
      break; // Only one auth type should be present
    }
  }

  if (type === 'noauth') {
    return { type };
  }

  if (type === 'inherit') {
    return { type };
  }

  return {
    type,
    credentials: credentials.length > 0 ? credentials : undefined
  };
}

/**
 * Transform v2 events to v3 scripts format
 * Maps v2 listen values to v3 script types
 */
function transformEventsToScripts(v2Events, context = 'http') {
  if (!v2Events || !Array.isArray(v2Events) || v2Events.length === 0) {
    return undefined;
  }

  const listenToTypeMap = {
    prerequest: context === 'http' ? 'beforeRequest' : `http:beforeRequest`,
    test: context === 'http' ? 'afterResponse' : `http:afterResponse`
  };

  const scripts = v2Events
    .map((v2Event) => {
      if (!v2Event || !v2Event.listen || !v2Event.script) {
        return null;
      }

      const scriptType = listenToTypeMap[v2Event.listen];
      if (!scriptType) {
        // Skip unknown listen types
        return null;
      }

      // Filter out empty code (empty arrays or arrays with only empty strings)
      const code = (v2Event.script.exec || []).filter(
        (line) => line && line.trim() !== ''
      );
      if (code.length === 0) {
        // Skip scripts with no actual code
        return null;
      }

      const script = {
        type: scriptType,
        code: code.length === 1 ? code[0] : code // String for single line, array for multiple lines
      };

      // Add language if it's text/javascript
      if (v2Event.script.type === 'text/javascript') {
        script.language = 'text/javascript';
      }

      // Handle script packages if present
      // Schema defines packages as a single object { id: string }, not an array
      if (v2Event.script.src) {
        if (
          Array.isArray(v2Event.script.src) &&
          v2Event.script.src.length > 0
        ) {
          // Take the first package (schema only supports single package object)
          script.packages = { id: v2Event.script.src[0] };
        } else if (typeof v2Event.script.src === 'string') {
          script.packages = { id: v2Event.script.src };
        }
      }

      // Handle script requests if present (v3 feature, not in v2, but preserve if already in v3)
      // Note: v2 doesn't have requests field, but we preserve it if transforming from v3 back
      // Only preserve if it has properties (not empty object)
      if (
        v2Event.script.requests &&
        typeof v2Event.script.requests === 'object' &&
        Object.keys(v2Event.script.requests).length > 0
      ) {
        script.requests = v2Event.script.requests;
      }

      return script;
    })
    .filter((script) => script !== null);

  return scripts.length > 0 ? scripts : undefined;
}

/**
 * Extract description string from v2 description (can be string or object)
 */
function extractDescription(v2Description) {
  if (!v2Description) {
    return undefined;
  }
  if (typeof v2Description === 'string') {
    return v2Description;
  }
  if (
    typeof v2Description === 'object' &&
    v2Description.content !== undefined
  ) {
    return v2Description.content || '';
  }
  return undefined;
}

/**
 * Transform v2 variable to v3 variable format
 */
function transformVariable(v2Var) {
  const variable = {
    key: v2Var.key || '',
    value: v2Var.value || ''
  };

  const description = extractDescription(v2Var.description);
  if (description !== undefined) {
    variable.description = description;
  }

  if (v2Var.disabled !== undefined) {
    variable.disabled = v2Var.disabled;
  }

  return variable;
}

/**
 * Transform v2 header/query param to v3 format
 */
function transformKeyValue(v2Item) {
  const item = {
    key: v2Item.key || '',
    value: v2Item.value || ''
  };

  const description = extractDescription(v2Item.description);
  if (description !== undefined) {
    item.description = description;
  }

  if (v2Item.disabled !== undefined) {
    item.disabled = v2Item.disabled;
  }

  return item;
}

/**
 * Transform v2 query param (can have null values)
 */
function transformQueryParam(v2Param) {
  const param = {
    key: v2Param.key ?? null,
    value: v2Param.value ?? null
  };

  const description = extractDescription(v2Param.description);
  if (description !== undefined) {
    param.description = description;
  }

  if (v2Param.disabled !== undefined) {
    param.disabled = v2Param.disabled;
  }

  return param;
}

/**
 * Transform v2 URL to v3 format
 */
function transformUrl(v2Url) {
  if (typeof v2Url === 'string') {
    return v2Url || '';
  }

  if (!v2Url) {
    return '';
  }

  // Build URL from v2 URL object
  if (v2Url.raw && v2Url.raw.trim() !== '') {
    return v2Url.raw;
  }

  // Construct from parts if raw is empty
  const parts = [];
  if (v2Url.protocol) {
    parts.push(v2Url.protocol + '://');
  }
  if (v2Url.host && Array.isArray(v2Url.host)) {
    parts.push(v2Url.host.join('.'));
  }
  if (v2Url.path && Array.isArray(v2Url.path)) {
    const pathStr = v2Url.path.join('/');
    if (pathStr) {
      parts.push(pathStr);
    }
  }
  if (v2Url.query && Array.isArray(v2Url.query) && v2Url.query.length > 0) {
    const queryStr = v2Url.query
      .map((q) => {
        if (q.value === null || q.value === undefined) {
          return q.key || '';
        }
        return `${q.key || ''}=${q.value || ''}`;
      })
      .filter((q) => q)
      .join('&');
    if (queryStr) {
      parts.push('?' + queryStr);
    }
  }

  const constructed = parts.join('');
  return constructed || '';
}

/**
 * Transform v2 body to v3 body format
 */
function transformBody(v2Body) {
  if (!v2Body || !v2Body.mode) {
    return { type: 'none' };
  }

  const modeMap = {
    raw: 'text',
    urlencoded: 'urlencoded',
    formdata: 'formdata',
    file: 'file',
    graphql: 'text'
  };

  const type = modeMap[v2Body.mode] || 'none';

  if (type === 'none') {
    return { type: 'none' };
  }

  if (type === 'urlencoded' || type === 'formdata') {
    const content = (v2Body[type] || []).map((item) => {
      const contentItem = {
        key: item.key || '',
        value: item.value || '',
        type: type === 'formdata' ? item.type || 'text' : undefined
      };

      const description = extractDescription(item.description);
      if (description !== undefined) {
        contentItem.description = description;
      }

      if (item.disabled !== undefined) {
        contentItem.disabled = item.disabled;
      }

      if (type === 'formdata' && item.type === 'file') {
        if (item.src) {
          contentItem.src = item.src;
        }
        delete contentItem.value;
      }

      if (item.contentType) {
        contentItem.contentType = item.contentType;
      }

      return contentItem;
    });

    return {
      type,
      content
    };
  }

  if (type === 'file') {
    return {
      type: 'file',
      content: {
        src: v2Body.file?.src || ''
      }
    };
  }

  // raw/text/json/xml/html/javascript
  const contentType = v2Body.options?.raw?.language || 'text';
  const content = v2Body.raw || v2Body[type] || '';
  return {
    type: contentType,
    content
  };
}

/**
 * Transform v2 request to v3 httpRequest format
 */
function transformRequest(v2Request) {
  // Skip requests with VIEW method (documentation-only) or empty URLs
  if (v2Request.method === 'VIEW' || !v2Request.url) {
    return null;
  }

  const url = transformUrl(v2Request.url);

  // Skip if URL is empty
  if (!url || url.trim() === '') {
    return null;
  }

  const request = {
    type: 'http',
    url: url
  };

  if (v2Request.method && v2Request.method !== 'VIEW') {
    request.method = v2Request.method;
  } else {
    // Default to GET if no method specified
    request.method = 'GET';
  }

  if (v2Request.header && v2Request.header.length > 0) {
    request.headers = v2Request.header.map(transformKeyValue);
  }

  if (v2Request.url && v2Request.url.query && v2Request.url.query.length > 0) {
    request.queryParams = v2Request.url.query.map(transformQueryParam);
  }

  if (
    v2Request.url &&
    v2Request.url.variable &&
    v2Request.url.variable.length > 0
  ) {
    request.pathVariables = v2Request.url.variable.map(transformKeyValue);
  }

  if (v2Request.body) {
    request.body = transformBody(v2Request.body);
  }

  if (v2Request.auth) {
    request.auth = transformAuth(v2Request.auth);
  }

  // Transform events to scripts
  if (v2Request.event && v2Request.event.length > 0) {
    const scripts = transformEventsToScripts(v2Request.event, 'http');
    if (scripts) {
      request.scripts = scripts;
    }
  }

  // Transform examples (responses)
  if (v2Request.response && v2Request.response.length > 0) {
    request.examples = v2Request.response.map((v2Response) => {
      const hasBody = v2Response.body && v2Response.body.trim() !== '';
      const hasHeaders = v2Response.header && v2Response.header.length > 0;

      const example = {
        response: {
          statusCode: v2Response.code || 200,
          statusText: v2Response.status || 'OK',
          // Body is required by schema, so always include it
          body: {
            type: 'text',
            content: hasBody ? v2Response.body : ''
          }
        }
      };

      // Try to detect body type if there's content
      if (hasBody) {
        const bodyStr = v2Response.body;
        if (bodyStr.trim().startsWith('{') || bodyStr.trim().startsWith('[')) {
          example.response.body.type = 'json';
        } else if (bodyStr.trim().startsWith('<')) {
          example.response.body.type = 'xml';
        } else if (
          bodyStr.trim().startsWith('<!DOCTYPE') ||
          bodyStr.trim().startsWith('<html')
        ) {
          example.response.body.type = 'html';
        }
      }

      if (hasHeaders) {
        example.response.headers = v2Response.header.map(transformKeyValue);
      }

      // Add name if present
      if (v2Response.name) {
        example.name = v2Response.name;
      }

      // Add description if present
      const exampleDescription = extractDescription(v2Response.description);
      if (exampleDescription !== undefined) {
        example.description = exampleDescription;
      }

      // Add id if present
      if (v2Response.id) {
        example.id = v2Response.id;
      }

      return example;
    });
  }

  return request;
}

/**
 * Transform v2 item (request or folder) to v3 format
 */
function transformItem(v2Item) {
  if (v2Item.request) {
    // It's a request
    const request = transformRequest(v2Item.request);

    // Skip invalid requests (VIEW method, empty URL, etc.)
    if (!request) {
      return null;
    }

    if (v2Item.name) {
      request.name = v2Item.name;
    }
    const description = extractDescription(v2Item.description);
    if (description !== undefined) {
      request.description = description;
    }
    if (v2Item.id) {
      request.id = v2Item.id;
    }

    // Handle responses at item level (v2 format)
    if (v2Item.response && v2Item.response.length > 0 && !request.examples) {
      request.examples = v2Item.response.map((v2Response) => {
        const hasBody = v2Response.body && v2Response.body.trim() !== '';
        const hasHeaders = v2Response.header && v2Response.header.length > 0;

        const example = {
          response: {
            statusCode: v2Response.code || 200,
            statusText: v2Response.status || 'OK',
            // Body is required by schema, so always include it
            body: {
              type: 'text',
              content: hasBody ? v2Response.body : ''
            }
          }
        };

        // Try to detect body type if there's content
        if (hasBody) {
          const bodyStr = v2Response.body;
          if (
            bodyStr.trim().startsWith('{') ||
            bodyStr.trim().startsWith('[')
          ) {
            example.response.body.type = 'json';
          } else if (bodyStr.trim().startsWith('<')) {
            example.response.body.type = 'xml';
          } else if (
            bodyStr.trim().startsWith('<!DOCTYPE') ||
            bodyStr.trim().startsWith('<html')
          ) {
            example.response.body.type = 'html';
          }
        }

        if (hasHeaders) {
          example.response.headers = v2Response.header.map(transformKeyValue);
        }

        // Add name if present
        if (v2Response.name) {
          example.name = v2Response.name;
        }

        return example;
      });
    }

    return request;
  } else if (v2Item.item && Array.isArray(v2Item.item)) {
    // It's a folder - transform all items and filter out nulls
    const transformedItems = v2Item.item
      .map(transformItem)
      .filter((item) => item !== null);

    // Only create folder if it has items or a description (documentation folder)
    if (transformedItems.length === 0 && !v2Item.description) {
      return null;
    }

    const folder = {
      type: 'folder',
      name: v2Item.name || '',
      items: transformedItems
    };

    const description = extractDescription(v2Item.description);
    if (description !== undefined) {
      folder.description = description;
    }

    if (v2Item.id) {
      folder.id = v2Item.id;
    }

    if (v2Item.auth) {
      folder.auth = transformAuth(v2Item.auth);
    }

    // Transform events to scripts
    if (v2Item.event && v2Item.event.length > 0) {
      const scripts = transformEventsToScripts(v2Item.event, 'collection');
      if (scripts) {
        folder.scripts = scripts;
      }
    }

    return folder;
  }

  // Fallback - skip items without request or item array
  return null;
}

/**
 * Transform v2 collection to v3 collection format
 */
function transformCollection(v2Collection) {
  const collection = {
    $schema: 'https://schema.postman.com/json/draft-2020-12/collection/v3.0.0/',
    type: 'collection',
    name: v2Collection.info?.name || 'Untitled Collection',
    items: []
  };

  const description = extractDescription(v2Collection.info?.description);
  if (description !== undefined) {
    collection.description = description;
  }

  if (v2Collection.info?._postman_id) {
    collection.id = v2Collection.info._postman_id;
  }

  // Transform variables
  if (v2Collection.variable && v2Collection.variable.length > 0) {
    collection.variables = v2Collection.variable.map(transformVariable);
  }

  // Transform auth
  if (v2Collection.auth) {
    collection.auth = transformAuth(v2Collection.auth);
  }

  // Transform events to scripts
  if (v2Collection.event && v2Collection.event.length > 0) {
    const scripts = transformEventsToScripts(v2Collection.event, 'collection');
    if (scripts) {
      collection.scripts = scripts;
    }
  }

  // Transform items and filter out nulls
  if (v2Collection.item && Array.isArray(v2Collection.item)) {
    collection.items = v2Collection.item
      .map(transformItem)
      .filter((item) => item !== null);
  }

  return collection;
}

/**
 * Recursively sanitize null bytes from strings in an object
 * Null bytes (\u0000) are invalid in JSON and must be removed
 */
function sanitizeNullBytes(obj) {
  if (typeof obj === 'string') {
    return obj.split('\0').join('');
  }
  if (Array.isArray(obj)) {
    return obj.map(sanitizeNullBytes);
  }
  if (obj && typeof obj === 'object') {
    const sanitized = {};
    for (const key in obj) {
      sanitized[key] = sanitizeNullBytes(obj[key]);
    }
    return sanitized;
  }
  return obj;
}

/**
 * Post-process YAML to convert script code arrays to block scalars
 * This converts array representation to block scalar for better YAML readability
 */
function convertScriptCodeArrayToBlockScalar(yamlStr) {
  const lines = yamlStr.split('\n');
  const result = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Check if this is a code field start
    const codeMatch = line.match(/^(\s+)code:\s*$/);
    if (codeMatch) {
      const indent = codeMatch[1];
      i++;

      // Collect array items
      const codeLines = [];
      while (i < lines.length) {
        const arrayLine = lines[i];
        // Check if this is an array item
        const arrayMatch = arrayLine.match(
          new RegExp(
            `^${indent.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}  - (.+)$`
          )
        );
        if (arrayMatch) {
          // Parse the YAML value (handle quoted strings)
          let content = arrayMatch[1].trim();
          // Remove surrounding quotes if present
          if (
            (content.startsWith('"') && content.endsWith('"')) ||
            (content.startsWith("'") && content.endsWith("'"))
          ) {
            content = content.slice(1, -1);
            // Unescape quotes (YAML uses '' for single quote in single-quoted strings)
            if (content.includes("''")) {
              content = content.replace(/''/g, "'");
            }
            if (content.includes('\\"')) {
              content = content.replace(/\\"/g, '"');
            }
          }
          codeLines.push(content);
          i++;
        } else {
          // Not an array item, break
          break;
        }
      }

      // Convert to block scalar
      if (codeLines.length > 0) {
        result.push(`${indent}code: |-`);
        codeLines.forEach((codeLine) => {
          result.push(`${indent}  ${codeLine}`);
        });
      } else {
        // No array items found, keep original
        result.push(line);
      }
    } else {
      result.push(line);
      i++;
    }
  }

  return result.join('\n');
}

/**
 * Sanitize folder name for filesystem
 */
function sanitizeFolderName(name) {
  return name
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .substring(0, 100); // Limit length
}

/**
 * Main function
 */
async function generateExamples() {
  try {
    // Ensure v3 directory exists
    await mkdir(v3Dir, { recursive: true });

    // Read all v2 collection files
    const files = await readdir(v2Dir);
    const v2Files = files.filter(
      (file) =>
        file.endsWith('.json') || file.endsWith('.postman_collection.json')
    );

    if (v2Files.length === 0) {
      globalThis.console.log('⚠️  No v2 collection files found in examples/v2');
      return;
    }

    globalThis.console.log(`🔄 Converting ${v2Files.length} v2 collection(s) to v3...`);

    for (const file of v2Files) {
      const filePath = join(v2Dir, file);

      // Read and parse v2 collection
      const v2Content = JSON.parse(await readFile(filePath, 'utf-8'));

      // Transform to v3
      const v3Collection = transformCollection(v2Content);

      // Get collection name for folder
      const collectionName = sanitizeFolderName(v3Collection.name);
      const collectionDir = join(v3Dir, collectionName);

      // Create collection directory
      await mkdir(collectionDir, { recursive: true });

      // Write JSON file
      const jsonPath = join(collectionDir, '_collection.json');
      const sanitizedCollection = sanitizeNullBytes(v3Collection);
      await writeFile(
        jsonPath,
        JSON.stringify(sanitizedCollection, null, 2),
        'utf-8'
      );

      // Write YAML file
      const yamlPath = join(collectionDir, '_collection.yaml');
      let yamlContent = yaml.dump(v3Collection, {
        indent: 2,
        lineWidth: -1,
        noRefs: true,
        sortKeys: false
      });

      // Post-process: Convert script code arrays to block scalars in YAML
      yamlContent = convertScriptCodeArrayToBlockScalar(yamlContent);

      await writeFile(yamlPath, yamlContent, 'utf-8');
      globalThis.console.log(`  ✓ ${collectionName}`);
    }

    globalThis.console.log(`✅ Generated ${v2Files.length} v3 collection(s)`);
  } catch (error) {
    globalThis.console.error('❌ Error:', error.message);
    if (error.stack) {
      globalThis.console.error(error.stack);
    }
    globalThis.process.exit(1);
  }
}

generateExamples();
