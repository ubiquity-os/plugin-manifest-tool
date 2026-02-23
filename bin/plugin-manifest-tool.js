#!/usr/bin/env node
const fs = require("fs").promises;
const fsSync = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { pathToFileURL } = require("url");

const execFileAsync = promisify(execFile);

const MANIFEST_EXPORT_KEYS = ["pluginSettingsSchema", "commandSchema"];
const DENO_OUTPUT_PREFIX = "__CODEX_MANIFEST_EXPORTS__";
const ENTRYPOINT_FNS = ["createPlugin", "createActionsPlugin"];
const DENO_BIN_OVERRIDE_ENV = "PLUGIN_MANIFEST_DENO_BIN";

/**
 * Resolves how to invoke Deno for runtime module loading.
 * Prefers explicit override, then bundled npm dependency, then PATH.
 *
 * @returns {{ command: string, argsPrefix: string[], source: "env" | "bundled" | "path" }}
 */
function resolveDenoCommand() {
  const override = process.env[DENO_BIN_OVERRIDE_ENV];
  if (typeof override === "string" && override.trim()) {
    return {
      command: override.trim(),
      argsPrefix: [],
      source: "env",
    };
  }

  try {
    const denoCliScript = require.resolve("deno/bin.cjs");
    return {
      command: process.execPath,
      argsPrefix: [denoCliScript],
      source: "bundled",
    };
  } catch {
    return {
      command: "deno",
      argsPrefix: [],
      source: "path",
    };
  }
}

/**
 * Detects whether an execution error was caused by a missing binary.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
function isMissingExecutableError(error) {
  if (!error) {
    return false;
  }

  if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
    return true;
  }

  const message = error && error.message ? error.message : String(error);
  return /enoent|not found/i.test(message);
}

/**
 * Recursively lists files under a directory.
 *
 * @param {string} rootDir
 * @returns {Promise<string[]>}
 */
async function listFilesRecursive(rootDir) {
  let entries;
  try {
    entries = await fs.readdir(rootDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursive(fullPath)));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

/**
 * Recursively finds files with a specific extension.
 *
 * @param {string} rootDir
 * @param {string} extension
 * @returns {Promise<string[]>}
 */
async function findFilesByExtension(rootDir, extension) {
  const lowerExt = extension.toLowerCase();
  const files = await listFilesRecursive(rootDir);
  return files.filter((file) => file.toLowerCase().endsWith(lowerExt)).sort((a, b) => a.localeCompare(b));
}

/**
 * Emits a GitHub Actions warning annotation.
 */
function warning(message) {
  console.log(`::warning::${message}`);
}

/**
 * Normalizes a skipBotEvents input value to a boolean.
 *
 * Accepts booleans directly and string values "true"/"false" (case-insensitive).
 * Any missing or invalid value falls back to true.
 *
 * @param {unknown} value
 * @returns {{ value: boolean, warning: string|null }}
 */
function normalizeSkipBotEvents(value) {
  if (typeof value === "boolean") {
    return { value, warning: null };
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") {
      return { value: true, warning: null };
    }
    if (normalized === "false") {
      return { value: false, warning: null };
    }

    if (normalized.length > 0) {
      return {
        value: true,
        warning: `manifest.skipBotEvents: invalid action input value "${value}" (expected "true" or "false"). Defaulting to true.`,
      };
    }
  }

  return { value: true, warning: null };
}

/**
 * Parses comma-separated event exclusions.
 *
 * @param {unknown} value
 * @returns {string[]}
 */
function parseExcludedSupportedEvents(value) {
  if (typeof value !== "string" || !value.trim()) {
    return [];
  }

  return [
    ...new Set(
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    ),
  ];
}

/**
 * Picks selected exports from a loaded module.
 * Supports both named exports and default-exported objects.
 *
 * @param {unknown} moduleValue
 * @param {string[]} exportKeys
 * @returns {Record<string, unknown>}
 */
function pickExports(moduleValue, exportKeys) {
  if (!moduleValue || typeof moduleValue !== "object") {
    return {};
  }

  const picked = {};
  for (const key of exportKeys) {
    if (Object.prototype.hasOwnProperty.call(moduleValue, key)) {
      picked[key] = moduleValue[key];
      continue;
    }

    const defaultExport = moduleValue.default;
    if (defaultExport && typeof defaultExport === "object" && Object.prototype.hasOwnProperty.call(defaultExport, key)) {
      picked[key] = defaultExport[key];
      continue;
    }

    if (key === "default" && moduleValue.default !== undefined) {
      picked[key] = moduleValue.default;
    }
  }

  return picked;
}

/**
 * Backward-compatible helper that picks manifest-specific exports.
 *
 * @param {unknown} moduleValue
 * @returns {Record<string, unknown>}
 */
function pickManifestExports(moduleValue) {
  return pickExports(moduleValue, MANIFEST_EXPORT_KEYS);
}

/**
 * Parses Deno loader stdout and extracts selected export payload.
 *
 * @param {string} stdout
 * @param {string[]} [exportKeys]
 * @returns {Record<string, unknown>}
 */
function parseDenoLoaderOutput(stdout, exportKeys = MANIFEST_EXPORT_KEYS) {
  const lines = String(stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const markerIndex = line.indexOf(DENO_OUTPUT_PREFIX);
    if (markerIndex === -1) continue;

    const payload = line.slice(markerIndex + DENO_OUTPUT_PREFIX.length);
    try {
      const parsed = JSON.parse(payload);
      return pickExports(parsed, exportKeys);
    } catch (error) {
      throw new Error(`Invalid JSON payload from Deno loader: ${error.message}`);
    }
  }

  throw new Error("No manifest export payload found in Deno loader output");
}

/**
 * Injects a minimal Deno shim for Node runtime module loading.
 * Returns true when the shim was injected by this function.
 */
function ensureNodeDenoShim() {
  if (typeof globalThis.Deno !== "undefined") {
    return false;
  }

  class NotFound extends Error {}

  globalThis.Deno = {
    env: {
      get: (name) => process.env[name],
      toObject: () => ({ ...process.env }),
    },
    cwd: () => process.cwd(),
    build: {
      os: process.platform,
      arch: process.arch,
    },
    errors: {
      NotFound,
    },
  };

  return true;
}

/**
 * Recursively removes properties from `required` arrays
 * when those properties have a `default` value defined.
 */
function customReviver(_key, value) {
  if (typeof value === "object" && value !== null) {
    if ("properties" in value && "required" in value) {
      const requiredFields = new Set(value.required);
      for (const [propKey, propValue] of Object.entries(value.properties)) {
        if (typeof propValue === "object" && "default" in propValue) {
          requiredFields.delete(propKey);
        }
      }
      value.required = Array.from(requiredFields);
      if (value.required.length === 0) {
        delete value.required;
      }
    }
  }
  return value;
}

/**
 * Validates that `commands` is a well-formed command map object.
 * Returns an error string if invalid, or null if valid.
 */
function validateCommands(commands) {
  if (typeof commands !== "object" || Array.isArray(commands) || commands === null) {
    return "commands must be a plain object (Record<string, CommandSchema>)";
  }
  for (const [key, cmd] of Object.entries(commands)) {
    if (typeof cmd !== "object" || cmd === null) {
      return `Command "${key}" must be an object`;
    }
    if (!cmd.description || typeof cmd.description !== "string") {
      return `Command "${key}" is missing a "description" string`;
    }
    if (!cmd["ubiquity:example"] || typeof cmd["ubiquity:example"] !== "string") {
      return `Command "${key}" is missing a "ubiquity:example" string`;
    }
  }
  return null;
}

/**
 * Attempts to convert a TypeBox-style command schema union into
 * the manifest commands map format.
 */
function convertTypeBoxCommandSchema(commandSchema, existingCommands = {}) {
  if (typeof commandSchema !== "object" || commandSchema === null || Array.isArray(commandSchema)) {
    return { commands: null, error: "commandSchema must be an object" };
  }

  const variants = Array.isArray(commandSchema.anyOf) ? commandSchema.anyOf : Array.isArray(commandSchema.oneOf) ? commandSchema.oneOf : null;

  if (!variants || variants.length === 0) {
    return {
      commands: null,
      error: "commandSchema is missing anyOf/oneOf command variants",
    };
  }

  const commands = {};

  for (const variant of variants) {
    if (typeof variant !== "object" || variant === null) {
      return {
        commands: null,
        error: "commandSchema variants must be objects",
      };
    }

    const nameSchema = variant?.properties?.name;
    let commandName = null;

    if (typeof nameSchema?.const === "string" && nameSchema.const.trim()) {
      commandName = nameSchema.const;
    } else if (Array.isArray(nameSchema?.enum) && nameSchema.enum.length === 1 && typeof nameSchema.enum[0] === "string" && nameSchema.enum[0].trim()) {
      commandName = nameSchema.enum[0];
    }

    if (!commandName) {
      return {
        commands: null,
        error: 'Each command variant must define a literal "name" (name.const or single-value name.enum)',
      };
    }

    const existingCommand = existingCommands?.[commandName];
    const description =
      (typeof nameSchema?.description === "string" && nameSchema.description.trim()) ||
      (typeof variant.description === "string" && variant.description.trim()) ||
      (typeof existingCommand?.description === "string" && existingCommand.description.trim()) ||
      commandName;

    let example = null;
    if (typeof nameSchema?.["ubiquity:example"] === "string" && nameSchema["ubiquity:example"].trim()) {
      example = nameSchema["ubiquity:example"];
    } else if (Array.isArray(nameSchema?.examples) && typeof nameSchema.examples[0] === "string" && nameSchema.examples[0].trim()) {
      example = nameSchema.examples[0];
    } else if (typeof existingCommand?.["ubiquity:example"] === "string" && existingCommand["ubiquity:example"].trim()) {
      example = existingCommand["ubiquity:example"];
    } else {
      example = `/${commandName}`;
    }

    const command = {
      description,
      "ubiquity:example": example,
    };

    const parameters = variant?.properties?.parameters;
    if (typeof parameters === "object" && parameters !== null && !Array.isArray(parameters)) {
      command.parameters = parameters;
    } else if (typeof existingCommand?.parameters === "object" && existingCommand.parameters !== null && !Array.isArray(existingCommand.parameters)) {
      command.parameters = existingCommand.parameters;
    }

    commands[commandName] = command;
  }

  const validationError = validateCommands(commands);
  if (validationError) {
    return {
      commands: null,
      error: `derived commands are invalid: ${validationError}`,
    };
  }

  return { commands, error: null };
}

/**
 * Validates that listeners is a well-formed listeners array.
 * Returns an error string if invalid, or null if valid.
 */
function validateListeners(listeners) {
  if (!Array.isArray(listeners)) {
    return "listeners must be an array of webhook event strings";
  }
  for (const listener of listeners) {
    if (typeof listener !== "string" || !listener.includes(".")) {
      return `Listener "${listener}" does not look like a valid webhook event (expected format: "event.action")`;
    }
  }
  return null;
}

/**
 * Orders manifest fields in a deterministic order to avoid noisy diffs.
 */
function orderManifestFields(manifest) {
  const fieldOrder = ["name", "short_name", "description", "commands", "ubiquity:listeners", "skipBotEvents", "configuration", "homepage_url"];

  const ordered = {};
  for (const key of fieldOrder) {
    if (manifest[key] !== undefined) {
      ordered[key] = manifest[key];
    }
  }
  for (const key of Object.keys(manifest)) {
    if (!(key in ordered)) {
      ordered[key] = manifest[key];
    }
  }
  return ordered;
}

/**
 * Core manifest building logic. Exported for testing.
 *
 * @param {object} existingManifest
 * @param {object} pluginModule
 * @param {object|null} packageJson
 * @param {object} repoInfo
 * @param {object} [options]
 * @param {string[]|null} [options.supportedEvents]
 * @param {boolean|string} [options.skipBotEvents]
 * @param {boolean} [options.allowMissingCommandSchema]
 * @returns {{ manifest: object, warnings: string[] }}
 */
function buildManifest(existingManifest, pluginModule, packageJson, repoInfo, options = {}) {
  const manifest = { ...existingManifest };
  const warnings = [];

  if (packageJson?.name && typeof packageJson.name === "string" && packageJson.name.trim()) {
    manifest["name"] = packageJson.name;
  } else if (manifest["name"]) {
    warnings.push(`manifest.name: no "name" found in package.json. Keeping existing manifest value: ${manifest["name"]}`);
  } else {
    warnings.push('manifest.name: no "name" found in package.json and no existing value in manifest.json. Field will be absent.');
  }

  manifest["short_name"] = `${repoInfo.repository}@${repoInfo.refName}`;

  if (packageJson?.description && typeof packageJson.description === "string" && packageJson.description.trim()) {
    manifest["description"] = packageJson.description;
  } else if (manifest["description"]) {
    warnings.push(`manifest.description: no "description" found in package.json. Keeping existing manifest value: ${manifest["description"]}`);
  } else {
    warnings.push('manifest.description: no "description" found in package.json and no existing value in manifest.json. Field will be absent.');
  }

  const commandSchema = pluginModule.commandSchema;
  if (commandSchema !== undefined && commandSchema !== null) {
    const validationError = validateCommands(commandSchema);
    if (!validationError) {
      manifest["commands"] = commandSchema;
    } else {
      const looksLikeTypeBoxUnion =
        typeof commandSchema === "object" && commandSchema !== null && (Array.isArray(commandSchema.anyOf) || Array.isArray(commandSchema.oneOf));

      if (!looksLikeTypeBoxUnion) {
        warnings.push(`manifest.commands: commandSchema export is invalid (${validationError}). Skipping.`);
      } else {
        const { commands: convertedCommands, error: conversionError } = convertTypeBoxCommandSchema(commandSchema, manifest["commands"]);
        if (convertedCommands) {
          manifest["commands"] = convertedCommands;
        } else {
          warnings.push(`manifest.commands: commandSchema export found but could not be converted (${conversionError}). Skipping.`);
        }
      }
    }
  } else if (!options.allowMissingCommandSchema) {
    warnings.push("manifest.commands: no command schema found from entrypoint metadata. Field will not be auto-generated.");
  }

  const supportedEvents = options.supportedEvents;
  if (supportedEvents !== undefined && supportedEvents !== null) {
    const validationError = validateListeners(supportedEvents);
    if (validationError) {
      warnings.push(`manifest["ubiquity:listeners"]: supported events found but invalid: ${validationError}. Skipping.`);
    } else {
      manifest["ubiquity:listeners"] = supportedEvents;
      console.log('manifest["ubiquity:listeners"]: derived from entrypoint generic type.');
    }
  } else {
    warnings.push('manifest["ubiquity:listeners"]: no supported events could be derived from entrypoint metadata. Field will not be auto-generated.');
  }

  const normalizedSkipBotEvents = normalizeSkipBotEvents(options.skipBotEvents);
  manifest["skipBotEvents"] = normalizedSkipBotEvents.value;
  if (normalizedSkipBotEvents.warning) {
    warnings.push(normalizedSkipBotEvents.warning);
  }

  const pluginSettingsSchema = pluginModule.pluginSettingsSchema;
  if (pluginSettingsSchema) {
    manifest["configuration"] = JSON.parse(JSON.stringify(pluginSettingsSchema), customReviver);
  } else {
    warnings.push("manifest.configuration: no settings schema found from entrypoint metadata. Configuration will not be auto-generated.");
  }

  return { manifest: orderManifestFields(manifest), warnings };
}

function skipStringLiteral(input, startIndex) {
  const quote = input[startIndex];
  let i = startIndex + 1;

  while (i < input.length) {
    const char = input[i];
    if (char === "\\") {
      i += 2;
      continue;
    }

    if (quote === "`" && char === "$" && input[i + 1] === "{") {
      const endInterpolation = findMatchingDelimiter(input, i + 1, "{", "}");
      if (endInterpolation === -1) {
        return input.length - 1;
      }
      i = endInterpolation + 1;
      continue;
    }

    if (char === quote) {
      return i;
    }

    i++;
  }

  return input.length - 1;
}

/**
 * Finds matching closing delimiter while skipping strings/comments.
 */
function findMatchingDelimiter(input, startIndex, openChar, closeChar) {
  if (input[startIndex] !== openChar) {
    return -1;
  }

  let depth = 0;
  for (let i = startIndex; i < input.length; i++) {
    const char = input[i];
    const next = input[i + 1];

    if (char === "'" || char === '"' || char === "`") {
      i = skipStringLiteral(input, i);
      continue;
    }

    if (char === "/" && next === "/") {
      while (i < input.length && input[i] !== "\n") i++;
      continue;
    }

    if (char === "/" && next === "*") {
      i += 2;
      while (i < input.length - 1 && !(input[i] === "*" && input[i + 1] === "/")) {
        i++;
      }
      i++;
      continue;
    }

    if (char === openChar) {
      depth++;
      continue;
    }

    if (char === closeChar) {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }

  return -1;
}

/**
 * Splits string by delimiter at top level only.
 */
function splitTopLevel(input, delimiter = ",", options = {}) {
  const { trackAngles = false } = options;
  const parts = [];

  let start = 0;
  let parenDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  let angleDepth = 0;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    const next = input[i + 1];

    if (char === "'" || char === '"' || char === "`") {
      i = skipStringLiteral(input, i);
      continue;
    }

    if (char === "/" && next === "/") {
      while (i < input.length && input[i] !== "\n") i++;
      continue;
    }

    if (char === "/" && next === "*") {
      i += 2;
      while (i < input.length - 1 && !(input[i] === "*" && input[i + 1] === "/")) {
        i++;
      }
      i++;
      continue;
    }

    if (char === "(") parenDepth++;
    else if (char === ")") parenDepth--;
    else if (char === "{") braceDepth++;
    else if (char === "}") braceDepth--;
    else if (char === "[") bracketDepth++;
    else if (char === "]") bracketDepth--;
    else if (trackAngles && char === "<") angleDepth++;
    else if (trackAngles && char === ">" && angleDepth > 0) angleDepth--;

    if (char === delimiter && parenDepth === 0 && braceDepth === 0 && bracketDepth === 0 && angleDepth === 0) {
      parts.push(input.slice(start, i));
      start = i + 1;
    }
  }

  parts.push(input.slice(start));
  return parts;
}

function findTopLevelChar(input, targetChar) {
  let parenDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    const next = input[i + 1];

    if (char === "'" || char === '"' || char === "`") {
      i = skipStringLiteral(input, i);
      continue;
    }

    if (char === "/" && next === "/") {
      while (i < input.length && input[i] !== "\n") i++;
      continue;
    }

    if (char === "/" && next === "*") {
      i += 2;
      while (i < input.length - 1 && !(input[i] === "*" && input[i + 1] === "/")) {
        i++;
      }
      i++;
      continue;
    }

    if (char === "(") parenDepth++;
    else if (char === ")") parenDepth--;
    else if (char === "{") braceDepth++;
    else if (char === "}") braceDepth--;
    else if (char === "[") bracketDepth++;
    else if (char === "]") bracketDepth--;

    if (char === targetChar && parenDepth === 0 && braceDepth === 0 && bracketDepth === 0) {
      return i;
    }
  }

  return -1;
}

function stripOuterParens(input) {
  let result = String(input || "").trim();
  while (result.startsWith("(") && result.endsWith(")")) {
    const endIndex = findMatchingDelimiter(result, 0, "(", ")");
    if (endIndex !== result.length - 1) break;
    result = result.slice(1, -1).trim();
  }
  return result;
}

function stripTypeAssertions(input) {
  let result = stripOuterParens(input);
  while (true) {
    const topLevelParts = splitTopLevel(result, ",", { trackAngles: false });
    if (topLevelParts.length !== 1) {
      return result;
    }

    const asIndex = result.match(/\s+as\s+/)?.index;
    if (asIndex === undefined) {
      return result;
    }

    result = stripOuterParens(result.slice(0, asIndex));
  }
}

function normalizeObjectKey(rawKey) {
  const key = rawKey.trim();
  if (/^[A-Za-z_$][\w$]*$/.test(key)) {
    return key;
  }
  const quoted = key.match(/^(["'])(.+)\1$/);
  if (quoted) {
    return quoted[2];
  }
  return null;
}

function extractObjectLiteral(expression) {
  const trimmed = stripOuterParens(String(expression || "").trim());
  const objectStart = trimmed.indexOf("{");
  if (objectStart === -1) return null;

  const objectEnd = findMatchingDelimiter(trimmed, objectStart, "{", "}");
  if (objectEnd === -1) return null;

  return trimmed.slice(objectStart, objectEnd + 1);
}

function parseObjectLiteral(expression) {
  const objectLiteral = extractObjectLiteral(expression);
  if (!objectLiteral) return null;

  const inner = objectLiteral.slice(1, -1).trim();
  const entries = splitTopLevel(inner, ",", { trackAngles: false })
    .map((entry) => entry.trim())
    .filter(Boolean);

  const properties = new Map();
  const spreads = [];

  for (const entry of entries) {
    if (entry.startsWith("...")) {
      spreads.push(entry.slice(3).trim());
      continue;
    }

    const colonIndex = findTopLevelChar(entry, ":");
    if (colonIndex === -1) {
      if (/^[A-Za-z_$][\w$]*$/.test(entry)) {
        properties.set(entry, entry);
      }
      continue;
    }

    const key = normalizeObjectKey(entry.slice(0, colonIndex));
    if (!key) continue;

    const value = entry.slice(colonIndex + 1).trim();
    properties.set(key, value);
  }

  return {
    raw: objectLiteral,
    properties,
    spreads,
  };
}

function extractIdentifierFromExpression(expression) {
  const normalized = stripTypeAssertions(expression);
  if (/^[A-Za-z_$][\w$]*$/.test(normalized)) {
    return normalized;
  }
  if (/^[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*$/.test(normalized)) {
    return normalized;
  }
  throw new Error(`Expression "${expression}" is not a supported identifier reference`);
}

function parseImports(content) {
  const imports = {
    named: new Map(),
    default: new Map(),
    namespace: new Map(),
  };

  const importRegex = /\bimport\s+([\s\S]*?)\s+from\s+["']([^"']+)["'](?:\s+with\s+\{[\s\S]*?\})?\s*;?/g;

  let match;
  while ((match = importRegex.exec(content)) !== null) {
    let clause = match[1].trim();
    const source = match[2];

    if (clause.startsWith("type ")) {
      clause = clause.slice(5).trim();
    }

    const commaParts = splitTopLevel(clause, ",", { trackAngles: false });
    if (commaParts.length > 1) {
      const [first, ...restParts] = commaParts;
      if (first && /^[A-Za-z_$][\w$]*$/.test(first.trim())) {
        imports.default.set(first.trim(), source);
      }
      clause = restParts.join(",").trim();
    }

    if (/^[A-Za-z_$][\w$]*$/.test(clause)) {
      imports.default.set(clause, source);
      continue;
    }

    const namespaceMatch = clause.match(/^\*\s+as\s+([A-Za-z_$][\w$]*)$/);
    if (namespaceMatch) {
      imports.namespace.set(namespaceMatch[1], source);
      continue;
    }

    const namedMatch = clause.match(/^\{([\s\S]*)\}$/);
    if (namedMatch) {
      const entries = splitTopLevel(namedMatch[1], ",", { trackAngles: false })
        .map((entry) => entry.trim())
        .filter(Boolean);

      for (const entry of entries) {
        const withoutType = entry.replace(/^type\s+/, "").trim();
        const asMatch = withoutType.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
        if (asMatch) {
          imports.named.set(asMatch[2], {
            importedName: asMatch[1],
            source,
          });
          continue;
        }

        if (/^[A-Za-z_$][\w$]*$/.test(withoutType)) {
          imports.named.set(withoutType, {
            importedName: withoutType,
            source,
          });
        }
      }
    }
  }

  return imports;
}

function parseReexports(content) {
  const reexports = {
    named: new Map(),
    star: [],
  };

  const namedReexportRegex = /\bexport(?:\s+type)?\s*\{([\s\S]*?)\}\s*from\s+["']([^"']+)["']\s*;?/g;

  let match;
  while ((match = namedReexportRegex.exec(content)) !== null) {
    const entries = splitTopLevel(match[1], ",", { trackAngles: false })
      .map((entry) => entry.trim())
      .filter(Boolean);

    for (const entry of entries) {
      const withoutType = entry.replace(/^type\s+/, "").trim();
      const asMatch = withoutType.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
      if (asMatch) {
        reexports.named.set(asMatch[2], {
          importedName: asMatch[1],
          source: match[2],
        });
        continue;
      }

      if (/^[A-Za-z_$][\w$]*$/.test(withoutType)) {
        reexports.named.set(withoutType, {
          importedName: withoutType,
          source: match[2],
        });
      }
    }
  }

  const starReexportRegex = /\bexport(?:\s+type)?\s*\*\s*from\s+["']([^"']+)["']\s*;?/g;
  while ((match = starReexportRegex.exec(content)) !== null) {
    reexports.star.push(match[1]);
  }

  return reexports;
}

function parseTypeAliases(content) {
  const aliases = new Map();

  // Matches `type Alias` declarations at line starts. The RHS is parsed manually
  // so we can support semicolonless style and nested `;` within object types.
  const typeAliasStartRegex = /(?:^|[\r\n])\s*(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)\b/g;

  let startMatch;
  while ((startMatch = typeAliasStartRegex.exec(content)) !== null) {
    const aliasName = startMatch[1];
    let equalsIndex = -1;

    let parenDepth = 0;
    let braceDepth = 0;
    let bracketDepth = 0;
    let angleDepth = 0;

    for (let i = typeAliasStartRegex.lastIndex; i < content.length; i++) {
      const char = content[i];
      const next = content[i + 1];

      if (char === "'" || char === '"' || char === "`") {
        i = skipStringLiteral(content, i);
        continue;
      }

      if (char === "/" && next === "/") {
        while (i < content.length && content[i] !== "\n") i++;
        continue;
      }

      if (char === "/" && next === "*") {
        i += 2;
        while (i < content.length - 1 && !(content[i] === "*" && content[i + 1] === "/")) {
          i++;
        }
        i++;
        continue;
      }

      if (char === "(") parenDepth++;
      else if (char === ")" && parenDepth > 0) parenDepth--;
      else if (char === "{") braceDepth++;
      else if (char === "}" && braceDepth > 0) braceDepth--;
      else if (char === "[") bracketDepth++;
      else if (char === "]" && bracketDepth > 0) bracketDepth--;
      else if (char === "<") angleDepth++;
      else if (char === ">" && angleDepth > 0) angleDepth--;

      if (char === "=" && parenDepth === 0 && braceDepth === 0 && bracketDepth === 0 && angleDepth === 0) {
        equalsIndex = i;
        break;
      }
    }

    if (equalsIndex === -1) {
      continue;
    }

    const expressionStart = equalsIndex + 1;
    const expressionEnd = findTypeAliasTerminator(content, expressionStart);
    const expression = content.slice(expressionStart, expressionEnd).trim();
    if (expression.length > 0) {
      aliases.set(aliasName, expression);
      typeAliasStartRegex.lastIndex = expressionEnd;
    }
  }

  return aliases;
}

function skipWhitespaceAndComments(input, startIndex) {
  let i = startIndex;
  while (i < input.length) {
    const char = input[i];
    const next = input[i + 1];

    if (/\s/.test(char)) {
      i++;
      continue;
    }

    if (char === "/" && next === "/") {
      i += 2;
      while (i < input.length && input[i] !== "\n") i++;
      continue;
    }

    if (char === "/" && next === "*") {
      i += 2;
      while (i < input.length - 1 && !(input[i] === "*" && input[i + 1] === "/")) {
        i++;
      }
      i += 2;
      continue;
    }

    break;
  }

  return i;
}

function isTypeDeclarationBoundary(input, startIndex) {
  const rest = input.slice(startIndex);
  return /^(?:export\s+)?(?:declare\s+)?(?:type|interface|class|function|const|let|var|enum|namespace|import)\b/.test(rest);
}

function findTypeAliasTerminator(input, startIndex) {
  let parenDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  let angleDepth = 0;

  for (let i = startIndex; i < input.length; i++) {
    const char = input[i];
    const next = input[i + 1];
    const previousBraceDepth = braceDepth;

    if (char === "'" || char === '"' || char === "`") {
      i = skipStringLiteral(input, i);
      continue;
    }

    if (char === "/" && next === "/") {
      while (i < input.length && input[i] !== "\n") i++;
      continue;
    }

    if (char === "/" && next === "*") {
      i += 2;
      while (i < input.length - 1 && !(input[i] === "*" && input[i + 1] === "/")) {
        i++;
      }
      i++;
      continue;
    }

    if (char === "(") parenDepth++;
    else if (char === ")" && parenDepth > 0) parenDepth--;
    else if (char === "{") braceDepth++;
    else if (char === "}" && braceDepth > 0) braceDepth--;
    else if (char === "[") bracketDepth++;
    else if (char === "]" && bracketDepth > 0) bracketDepth--;
    else if (char === "<") angleDepth++;
    else if (char === ">" && angleDepth > 0) angleDepth--;

    if (parenDepth === 0 && braceDepth === 0 && bracketDepth === 0 && angleDepth === 0) {
      if (char === ";") {
        return i;
      }

      if (char === "}" && previousBraceDepth === 0) {
        return i;
      }

      if (char === "\n" || char === "\r") {
        const nextIndex = skipWhitespaceAndComments(input, i + 1);
        if (nextIndex >= input.length) {
          return input.length;
        }

        if (input[nextIndex] === "}" || isTypeDeclarationBoundary(input, nextIndex)) {
          return i;
        }
      }
    }
  }

  return input.length;
}

async function readParsedSource(filePath, cache) {
  if (cache.has(filePath)) {
    return cache.get(filePath);
  }

  const content = await fs.readFile(filePath, "utf8");
  const parsed = {
    filePath,
    content,
    imports: parseImports(content),
    reexports: parseReexports(content),
    typeAliases: parseTypeAliases(content),
  };
  cache.set(filePath, parsed);
  return parsed;
}

function resolveTsModulePath(fromFile, specifier) {
  if (!specifier || !specifier.startsWith(".")) {
    return null;
  }

  const basePath = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [
    basePath,
    `${basePath}.ts`,
    `${basePath}.tsx`,
    `${basePath}.mts`,
    `${basePath}.cts`,
    path.join(basePath, "index.ts"),
    path.join(basePath, "index.tsx"),
    path.join(basePath, "index.mts"),
    path.join(basePath, "index.cts"),
  ];

  if (/\.(js|mjs|cjs)$/.test(basePath)) {
    const withoutJs = basePath.replace(/\.(js|mjs|cjs)$/, "");
    candidates.push(`${withoutJs}.ts`, `${withoutJs}.tsx`, `${withoutJs}.mts`, `${withoutJs}.cts`);
  }

  for (const candidate of candidates) {
    if (fsSync.existsSync(candidate) && fsSync.statSync(candidate).isFile()) {
      return candidate;
    }
  }

  return null;
}

async function resolveTypeAlias(aliasName, filePath, projectRoot, cache, seen = new Set()) {
  const key = `${filePath}::${aliasName}`;
  if (seen.has(key)) {
    throw new Error(`Circular type alias resolution detected for ${aliasName}`);
  }
  seen.add(key);

  const parsed = await readParsedSource(filePath, cache);
  if (parsed.typeAliases.has(aliasName)) {
    return {
      aliasName,
      expression: parsed.typeAliases.get(aliasName),
      filePath,
    };
  }

  const importedAlias = parsed.imports.named.get(aliasName);
  if (importedAlias) {
    const modulePath = resolveTsModulePath(filePath, importedAlias.source);
    if (!modulePath) {
      throw new Error(`Could not resolve module "${importedAlias.source}" for imported type alias "${aliasName}" in ${path.relative(projectRoot, filePath)}`);
    }

    return resolveTypeAlias(importedAlias.importedName, modulePath, projectRoot, cache, seen);
  }

  const reexport = parsed.reexports.named.get(aliasName);
  if (reexport) {
    const modulePath = resolveTsModulePath(filePath, reexport.source);
    if (!modulePath) {
      throw new Error(`Could not resolve re-export module "${reexport.source}" for type alias "${aliasName}" in ${path.relative(projectRoot, filePath)}`);
    }

    return resolveTypeAlias(reexport.importedName, modulePath, projectRoot, cache, seen);
  }

  for (const source of parsed.reexports.star) {
    const modulePath = resolveTsModulePath(filePath, source);
    if (!modulePath) continue;

    try {
      return await resolveTypeAlias(aliasName, modulePath, projectRoot, cache, seen);
    } catch {
      // continue searching other star re-exports
    }
  }

  throw new Error(`Could not resolve type alias "${aliasName}" from ${path.relative(projectRoot, filePath)}`);
}

function extractStringLiterals(input) {
  const literals = [];
  const literalRegex = /(["'])(?:\\.|(?!\1)[^\\\r\n])*\1/g;
  let match;
  while ((match = literalRegex.exec(input)) !== null) {
    const quote = match[1];
    const rawLiteral = match[0].slice(1, -1);
    const normalizedLiteral = rawLiteral.replace(new RegExp(`\\\\${quote}`, "g"), quote).replace(/\\\\/g, "\\");
    literals.push(normalizedLiteral);
  }
  return [...new Set(literals)];
}

async function resolveSupportedEventsFromTypeExpression(typeExpression, filePath, projectRoot, cache, seen = new Set()) {
  const normalized = stripOuterParens(typeExpression);
  const literals = extractStringLiterals(normalized);
  if (literals.length > 0) {
    return literals;
  }

  if (/^[A-Za-z_$][\w$]*$/.test(normalized)) {
    const alias = await resolveTypeAlias(normalized, filePath, projectRoot, cache, seen);
    return resolveSupportedEventsFromTypeExpression(alias.expression, alias.filePath, projectRoot, cache, seen);
  }

  throw new Error(`Supported events type expression "${typeExpression}" is not a string-literal union or traceable alias`);
}

function parseStaticDecodeTypeAlias(aliasExpression) {
  const normalized = aliasExpression.replace(/\s+/g, " ").trim();
  const match = normalized.match(/^(?:[A-Za-z_$][\w$]*\.)?Static(?:Decode)?\s*<\s*typeof\s+([A-Za-z_$][\w$]*)\s*>$/);
  if (!match) {
    return null;
  }
  return match[1];
}

async function resolveRuntimeReferenceFromIdentifier(identifierExpression, filePath, projectRoot, cache) {
  const normalized = extractIdentifierFromExpression(identifierExpression);
  const parsed = await readParsedSource(filePath, cache);

  const namespaceMemberMatch = normalized.match(/^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/);
  if (namespaceMemberMatch) {
    const namespaceSource = parsed.imports.namespace.get(namespaceMemberMatch[1]);
    if (!namespaceSource) {
      throw new Error(`Namespace import "${namespaceMemberMatch[1]}" not found in ${path.relative(projectRoot, filePath)}`);
    }

    const modulePath = resolveTsModulePath(filePath, namespaceSource);
    if (!modulePath) {
      throw new Error(`Could not resolve module "${namespaceSource}" from ${path.relative(projectRoot, filePath)}`);
    }

    return {
      modulePath,
      exportName: namespaceMemberMatch[2],
      sourceExpression: identifierExpression,
    };
  }

  const namedImport = parsed.imports.named.get(normalized);
  if (namedImport) {
    const modulePath = resolveTsModulePath(filePath, namedImport.source);
    if (!modulePath) {
      throw new Error(`Could not resolve module "${namedImport.source}" from ${path.relative(projectRoot, filePath)}`);
    }

    return {
      modulePath,
      exportName: namedImport.importedName,
      sourceExpression: identifierExpression,
    };
  }

  const defaultImportSource = parsed.imports.default.get(normalized);
  if (defaultImportSource) {
    const modulePath = resolveTsModulePath(filePath, defaultImportSource);
    if (!modulePath) {
      throw new Error(`Could not resolve default import module "${defaultImportSource}" from ${path.relative(projectRoot, filePath)}`);
    }

    return {
      modulePath,
      exportName: "default",
      sourceExpression: identifierExpression,
    };
  }

  return {
    modulePath: filePath,
    exportName: normalized,
    sourceExpression: identifierExpression,
  };
}

function findCallsitesInSource(filePath, content, functionName) {
  const callsites = [];
  const matcher = new RegExp(`\\b${functionName}\\s*<`, "g");

  let match;
  while ((match = matcher.exec(content)) !== null) {
    const fnStart = match.index;
    const genericStart = content.indexOf("<", fnStart + functionName.length);
    if (genericStart === -1) continue;

    const genericEnd = findMatchingDelimiter(content, genericStart, "<", ">");
    if (genericEnd === -1) continue;

    let cursor = genericEnd + 1;
    while (cursor < content.length && /\s/.test(content[cursor])) cursor++;
    if (content[cursor] !== "(") continue;

    const argsStart = cursor;
    const argsEnd = findMatchingDelimiter(content, argsStart, "(", ")");
    if (argsEnd === -1) continue;

    const genericText = content.slice(genericStart + 1, genericEnd);
    const argsText = content.slice(argsStart + 1, argsEnd);

    callsites.push({
      functionName,
      filePath,
      genericArgs: splitTopLevel(genericText, ",", { trackAngles: true })
        .map((arg) => arg.trim())
        .filter(Boolean),
      args: splitTopLevel(argsText, ",", { trackAngles: false })
        .map((arg) => arg.trim())
        .filter(Boolean),
      index: fnStart,
    });

    matcher.lastIndex = argsEnd + 1;
  }

  return callsites;
}

async function findEntrypointCallsite(projectRoot) {
  const srcDir = path.join(projectRoot, "src");
  if (!fsSync.existsSync(srcDir)) {
    throw new Error('Source directory "src" does not exist.');
  }

  const tsFiles = await findFilesByExtension(srcDir, ".ts");
  const pluginCallsites = [];
  const actionCallsites = [];

  for (const filePath of tsFiles) {
    const content = await fs.readFile(filePath, "utf8");
    pluginCallsites.push(...findCallsitesInSource(filePath, content, "createPlugin"));
    actionCallsites.push(...findCallsitesInSource(filePath, content, "createActionsPlugin"));
  }

  if (pluginCallsites.length > 1) {
    throw new Error(
      `Multiple createPlugin callsites detected (${pluginCallsites
        .map((call) => path.relative(projectRoot, call.filePath))
        .join(", ")}). Exactly one is required.`
    );
  }

  if (pluginCallsites.length === 1) {
    return pluginCallsites[0];
  }

  if (actionCallsites.length > 1) {
    throw new Error(
      `Multiple createActionsPlugin callsites detected (${actionCallsites
        .map((call) => path.relative(projectRoot, call.filePath))
        .join(", ")}). Exactly one is required when createPlugin is absent.`
    );
  }

  if (actionCallsites.length === 1) {
    return actionCallsites[0];
  }

  throw new Error("No createPlugin<...>(...) or createActionsPlugin<...>(...) callsite with explicit generics was found in src/**/*.ts.");
}

/**
 * Loads selected exports from a module using Deno-first, then Node ESM/CJS fallbacks.
 */
async function loadPluginModule(modulePath, exportKeys = MANIFEST_EXPORT_KEYS) {
  const loadErrors = [];
  const denoCommand = resolveDenoCommand();

  try {
    const moduleUrl = pathToFileURL(modulePath).href;
    const script = `
const moduleUrl = ${JSON.stringify(moduleUrl)};
const keys = ${JSON.stringify(exportKeys)};
const loaded = await import(moduleUrl);
const out = {};
for (const key of keys) {
  if (Object.prototype.hasOwnProperty.call(loaded, key)) {
    out[key] = loaded[key];
    continue;
  }

  if (
    loaded.default &&
    typeof loaded.default === "object" &&
    Object.prototype.hasOwnProperty.call(loaded.default, key)
  ) {
    out[key] = loaded.default[key];
    continue;
  }

  if (key === "default" && loaded.default !== undefined) {
    out[key] = loaded.default;
  }
}
console.log(${JSON.stringify(DENO_OUTPUT_PREFIX)} + JSON.stringify(out));
`;

    const { stdout } = await execFileAsync(denoCommand.command, [...denoCommand.argsPrefix, "eval", "--quiet", script], {
      maxBuffer: 20 * 1024 * 1024,
      timeout: 60_000,
    });

    return parseDenoLoaderOutput(stdout, exportKeys);
  } catch (denoError) {
    loadErrors.push({ runtime: `deno-${denoCommand.source}`, error: denoError });
  }

  let injectedDenoShim = false;
  try {
    injectedDenoShim = ensureNodeDenoShim();
    const pluginModule = await import(pathToFileURL(modulePath).href);
    return pickExports(pluginModule, exportKeys);
  } catch (esmError) {
    loadErrors.push({
      runtime: injectedDenoShim ? "node-esm+deno-shim" : "node-esm",
      error: esmError,
    });

    try {
      const pluginModule = require(modulePath);
      return pickExports(pluginModule, exportKeys);
    } catch (cjsError) {
      loadErrors.push({ runtime: "node-cjs", error: cjsError });
      const details = loadErrors
        .map(({ runtime, error }) => {
          const message = error && error.message ? error.message : String(error);
          return `[${runtime}] ${message}`;
        })
        .join("\n");
      const denoFailure = loadErrors.find((item) => item.runtime.startsWith("deno-"));
      const denoHint =
        denoFailure && isMissingExecutableError(denoFailure.error)
          ? `\nHint: could not find a Deno runtime. Ensure optional dependencies are installed, install Deno globally, or set ${DENO_BIN_OVERRIDE_ENV}=/path/to/deno.`
          : "";
      throw new Error(`Error loading module from ${modulePath}:\n${details}${denoHint}`);
    }
  } finally {
    if (injectedDenoShim) {
      delete globalThis.Deno;
    }
  }
}

async function loadRuntimeReferenceValue(reference, projectRoot) {
  const loaded = await loadPluginModule(reference.modulePath, [reference.exportName]);
  const value = loaded[reference.exportName];
  if (value === undefined) {
    throw new Error(
      `Export "${reference.exportName}" was not found in ${path.relative(projectRoot, reference.modulePath)} while resolving "${reference.sourceExpression}".`
    );
  }
  return value;
}

async function extractManifestMetadataFromEntrypoint(projectRoot, excludeSupportedEventsInput = "") {
  const sourceCache = new Map();
  const entrypoint = await findEntrypointCallsite(projectRoot);

  if (entrypoint.genericArgs.length < 4) {
    throw new Error(
      `${entrypoint.functionName} in ${path.relative(projectRoot, entrypoint.filePath)} must provide explicit generic arguments <TConfig, TEnv, TCommand, TSupportedEvents>.`
    );
  }

  const optionsArgIndex = entrypoint.functionName === "createPlugin" ? 2 : 1;
  const optionsExpression = entrypoint.args[optionsArgIndex];
  if (!optionsExpression) {
    throw new Error(
      `${entrypoint.functionName} in ${path.relative(projectRoot, entrypoint.filePath)} is missing the options object argument that must include settingsSchema.`
    );
  }

  const optionsObject = parseObjectLiteral(optionsExpression);
  if (!optionsObject) {
    throw new Error(`Could not parse ${entrypoint.functionName} options object in ${path.relative(projectRoot, entrypoint.filePath)}.`);
  }

  if (!optionsObject.properties.has("settingsSchema")) {
    throw new Error(
      `${entrypoint.functionName} options in ${path.relative(projectRoot, entrypoint.filePath)} must include a direct "settingsSchema" property.`
    );
  }

  const settingsSchemaExpr = optionsObject.properties.get("settingsSchema");
  const settingsSchemaRef = await resolveRuntimeReferenceFromIdentifier(settingsSchemaExpr, entrypoint.filePath, projectRoot, sourceCache);
  const pluginSettingsSchema = await loadRuntimeReferenceValue(settingsSchemaRef, projectRoot);

  const commandTypeExpr = entrypoint.genericArgs[2];
  const normalizedCommandType = stripOuterParens(commandTypeExpr).trim();
  let commandSchema;
  let allowMissingCommandSchema = false;

  if (normalizedCommandType === "null") {
    allowMissingCommandSchema = true;
  } else if (/^[A-Za-z_$][\w$]*$/.test(normalizedCommandType)) {
    const alias = await resolveTypeAlias(normalizedCommandType, entrypoint.filePath, projectRoot, sourceCache);
    const commandSchemaSymbol = parseStaticDecodeTypeAlias(alias.expression);
    if (!commandSchemaSymbol) {
      throw new Error(
        `Command type alias "${alias.aliasName}" in ${path.relative(projectRoot, alias.filePath)} must be declared as StaticDecode<typeof X> or Static<typeof X>.`
      );
    }

    const commandSchemaRef = await resolveRuntimeReferenceFromIdentifier(commandSchemaSymbol, alias.filePath, projectRoot, sourceCache);
    commandSchema = await loadRuntimeReferenceValue(commandSchemaRef, projectRoot);
  } else {
    throw new Error(`TCommand generic "${commandTypeExpr}" in ${path.relative(projectRoot, entrypoint.filePath)} must be "null" or a traceable type alias.`);
  }

  const supportedEventsExpr = entrypoint.genericArgs[3];
  const supportedEvents = await resolveSupportedEventsFromTypeExpression(supportedEventsExpr, entrypoint.filePath, projectRoot, sourceCache);

  if (!supportedEvents.length) {
    throw new Error(`No supported events were resolved from generic "${supportedEventsExpr}" in ${path.relative(projectRoot, entrypoint.filePath)}.`);
  }

  const excludedSupportedEvents = parseExcludedSupportedEvents(excludeSupportedEventsInput);
  const unknownExclusions = excludedSupportedEvents.filter((event) => !supportedEvents.includes(event));
  if (unknownExclusions.length > 0) {
    throw new Error(`excludeSupportedEvents contains unknown event(s): ${unknownExclusions.join(", ")}. Available events: ${supportedEvents.join(", ")}`);
  }

  const filteredSupportedEvents = supportedEvents.filter((event) => !excludedSupportedEvents.includes(event));

  return {
    pluginSettingsSchema,
    commandSchema,
    allowMissingCommandSchema,
    supportedEvents: filteredSupportedEvents,
    excludedSupportedEvents,
    entrypoint,
  };
}

/**
 * Backward-compatible helper: scans for type alias by name in src/ and extracts string literals.
 *
 * @param {string} projectRoot
 * @param {string} [typeAliasName]
 * @returns {Promise<string[]|null>}
 */
async function extractSupportedEvents(projectRoot, typeAliasName = "SupportedEvents") {
  const srcDir = path.join(projectRoot, "src");
  if (!fsSync.existsSync(srcDir)) {
    return null;
  }

  const tsFiles = await findFilesByExtension(srcDir, ".ts");
  const cache = new Map();

  for (const filePath of tsFiles) {
    const parsed = await readParsedSource(filePath, cache);
    if (!parsed.typeAliases.has(typeAliasName)) continue;

    const resolved = await resolveSupportedEventsFromTypeExpression(parsed.typeAliases.get(typeAliasName), filePath, projectRoot, cache);

    if (resolved.length > 0) {
      const relativePath = path.relative(projectRoot, filePath);
      console.log(`Found ${typeAliasName} type in ${relativePath}: ${JSON.stringify(resolved)}`);
      return resolved;
    }
  }

  return null;
}

/**
 * Formats manifest.json with Prettier.
 * Best-effort only: emits a warning if Prettier is unavailable.
 */
async function formatManifestWithPrettier(manifestPath, cwd) {
  const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";
  try {
    await execFileAsync(npxCommand, ["prettier", "--write", manifestPath], { cwd, maxBuffer: 20 * 1024 * 1024 });
    return true;
  } catch (error) {
    warning(`Could not format manifest with Prettier: ${error.message || String(error)}`);
    return false;
  }
}

/**
 * Resolves configuration from environment variables (CI mode) or CLI arguments (local mode).
 */
function resolveConfig() {
  const localProjectRoot = process.argv[2];

  if (localProjectRoot) {
    const projectRoot = path.resolve(localProjectRoot);
    return {
      manifestPath: path.join(projectRoot, "manifest.json"),
      projectRoot,
      repository: `local/${path.basename(projectRoot)}`,
      refName: "local",
      skipBotEvents: process.env.SKIP_BOT_EVENTS ?? "true",
      excludeSupportedEvents: process.env.EXCLUDE_SUPPORTED_EVENTS ?? "",
    };
  }

  const manifestPath = process.env.MANIFEST_PATH;
  const projectRoot = process.env.GITHUB_WORKSPACE;
  const repository = process.env.GITHUB_REPOSITORY;
  const refName = process.env.GITHUB_REF_NAME;
  const skipBotEvents = process.env.SKIP_BOT_EVENTS ?? "true";
  const excludeSupportedEvents = process.env.EXCLUDE_SUPPORTED_EVENTS ?? "";

  if (!manifestPath || !projectRoot || !repository || !refName) {
    console.error("Missing required environment variables (MANIFEST_PATH, GITHUB_WORKSPACE, GITHUB_REPOSITORY, GITHUB_REF_NAME)");
    console.error("\nFor local testing, pass the project root as an argument:\n  node update-manifest.js /path/to/plugin-project");
    process.exit(1);
  }

  return {
    manifestPath,
    projectRoot,
    repository,
    refName,
    skipBotEvents,
    excludeSupportedEvents,
  };
}

/**
 * Main entrypoint — reads files, builds manifest, writes output.
 */
async function main() {
  const config = resolveConfig();

  let metadata;
  try {
    metadata = await extractManifestMetadataFromEntrypoint(config.projectRoot, config.excludeSupportedEvents);
  } catch (error) {
    console.error(`Manifest metadata detection failed: ${error.message || String(error)}`);
    process.exit(1);
  }

  const pluginModule = {
    pluginSettingsSchema: metadata.pluginSettingsSchema,
  };
  if (metadata.commandSchema !== undefined) {
    pluginModule.commandSchema = metadata.commandSchema;
  }

  const exportsSummary = {
    pluginSettingsSchema: !!pluginModule.pluginSettingsSchema,
    commandSchema: pluginModule.commandSchema !== undefined,
    entrypoint: {
      functionName: metadata.entrypoint.functionName,
      file: path.relative(config.projectRoot, metadata.entrypoint.filePath),
    },
    excludedSupportedEvents: metadata.excludedSupportedEvents,
  };
  console.log("Discovered metadata:", JSON.stringify(exportsSummary));

  let packageJson = null;
  try {
    const pkgPath = path.resolve(config.projectRoot, "package.json");
    packageJson = JSON.parse(await fs.readFile(pkgPath, "utf8"));
  } catch (error) {
    warning(`Could not read package.json: ${error.message}`);
  }

  let existingManifest = {};
  try {
    existingManifest = JSON.parse(await fs.readFile(config.manifestPath, "utf8"));
  } catch {
    console.log(`No existing manifest at ${config.manifestPath}, starting fresh.`);
  }

  const { manifest, warnings: buildWarnings } = buildManifest(
    existingManifest,
    pluginModule,
    packageJson,
    { repository: config.repository, refName: config.refName },
    {
      supportedEvents: metadata.supportedEvents,
      skipBotEvents: config.skipBotEvents,
      allowMissingCommandSchema: metadata.allowMissingCommandSchema,
    }
  );

  for (const w of buildWarnings) {
    warning(w);
  }

  const updatedManifest = JSON.stringify(manifest, null, 2);
  await fs.writeFile(config.manifestPath, updatedManifest, "utf8");
  await formatManifestWithPrettier(config.manifestPath, config.projectRoot);
  console.log(`Manifest written to ${config.manifestPath}`);
}

module.exports = {
  buildManifest,
  customReviver,
  validateCommands,
  convertTypeBoxCommandSchema,
  validateListeners,
  extractSupportedEvents,
  orderManifestFields,
  formatManifestWithPrettier,
  pickManifestExports,
  parseDenoLoaderOutput,
  ensureNodeDenoShim,
  resolveDenoCommand,
  isMissingExecutableError,
  normalizeSkipBotEvents,
  parseExcludedSupportedEvents,
  findMatchingDelimiter,
  splitTopLevel,
  parseObjectLiteral,
  parseTypeAliases,
  parseImports,
  resolveTsModulePath,
  parseStaticDecodeTypeAlias,
  findCallsitesInSource,
  findEntrypointCallsite,
  resolveTypeAlias,
  resolveSupportedEventsFromTypeExpression,
  resolveRuntimeReferenceFromIdentifier,
  loadPluginModule,
  extractManifestMetadataFromEntrypoint,
};

if (require.main === module) {
  main();
}
