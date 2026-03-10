const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const {
  buildManifest,
  customReviver,
  validateCommands,
  convertTypeBoxCommandSchema,
  validateListeners,
  orderManifestFields,
  pickManifestExports,
  parseDenoLoaderOutput,
  ensureNodeDenoShim,
  resolveDenoCommand,
  isMissingExecutableError,
  parseRepositoryFromRemoteUrl,
  parseRefNameFromGitHubRef,
  resolveConfig,
  normalizeSkipBotEvents,
  parseExcludedSupportedEvents,
  parseStaticDecodeTypeAlias,
  findMatchingDelimiter,
  splitTopLevel,
  parseObjectLiteral,
  parseImports,
  parseTypeAliases,
  resolveTsModulePath,
  findCallsitesInSource,
  findEntrypointCallsite,
  resolveSupportedEventsFromTypeExpression,
  resolveRuntimeReferenceFromIdentifier,
  extractManifestMetadataFromEntrypoint,
} = require("../bin/plugin-manifest-tool.js");

const REPO_INFO = {
  repository: "ubiquity-os/test-plugin",
  refName: "main",
};

let tmpRoot;
let projectCounter = 0;

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "update-manifest-tests-"));
});

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function createProject(name = "project") {
  projectCounter += 1;
  const projectRoot = path.join(tmpRoot, `${name}-${projectCounter}`);
  fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });
  return projectRoot;
}

function writeProjectFile(projectRoot, relativePath, content) {
  const fullPath = path.join(projectRoot, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, "utf8");
  return fullPath;
}

function scaffoldStandardPlugin(projectRoot, options = {}) {
  const { entrypointFile = "src/worker.ts", entrypointSource, typesSource, schemasSource } = options;

  writeProjectFile(
    projectRoot,
    "src/schemas.mjs",
    schemasSource ||
      `export const settingsRuntimeSchema = {
  type: "object",
  properties: {
    greeting: { type: "string", default: "hello" }
  },
  required: ["greeting"]
};

export const commandRuntimeSchema = {
  start: {
    description: "Start command",
    "ubiquity:example": "/start"
  }
};
`
  );

  writeProjectFile(
    projectRoot,
    "src/types.ts",
    typesSource ||
      `import type { StaticDecode } from "@sinclair/typebox";
import { commandRuntimeSchema } from "./schemas.mjs";

export type PluginConfig = { enabled: boolean };
export type PluginContext = { eventName: string };
export type CommandInput = StaticDecode<typeof commandRuntimeSchema>;
export type SupportedEvents =
  | "issue_comment.created"
  | "pull_request.opened"
  | "issues.labeled";
`
  );

  writeProjectFile(
    projectRoot,
    entrypointFile,
    entrypointSource ||
      `import { createPlugin } from "@ubiquity-os/plugin-sdk/worker";
import { settingsRuntimeSchema } from "./schemas.mjs";
import type {
  PluginConfig,
  PluginContext,
  CommandInput,
  SupportedEvents,
} from "./types";

export const plugin = createPlugin<
  PluginConfig,
  PluginContext,
  CommandInput,
  SupportedEvents
>(
  {},
  {},
  {
    settingsSchema: settingsRuntimeSchema,
  },
);
`
  );
}

describe("buildManifest", () => {
  it("generates fields from package info, schemas, supported events and skipBotEvents", () => {
    const existingManifest = { homepage_url: "https://example.com" };
    const pluginModule = {
      pluginSettingsSchema: {
        type: "object",
        properties: {
          greeting: { type: "string", default: "hello" },
        },
        required: ["greeting"],
      },
      commandSchema: {
        ping: {
          description: "Ping command",
          "ubiquity:example": "/ping",
        },
      },
    };

    const { manifest, warnings } = buildManifest(existingManifest, pluginModule, { name: "test-plugin", description: "Test plugin" }, REPO_INFO, {
      supportedEvents: ["issue_comment.created", "pull_request.opened"],
      skipBotEvents: "false",
    });

    assert.equal(manifest.name, "test-plugin");
    assert.equal(manifest.short_name, "ubiquity-os/test-plugin@main");
    assert.equal(manifest.description, "Test plugin");
    assert.equal(manifest.skipBotEvents, false);
    assert.deepEqual(manifest.commands, pluginModule.commandSchema);
    assert.deepEqual(manifest["ubiquity:listeners"], ["issue_comment.created", "pull_request.opened"]);
    assert.deepEqual(Object.keys(manifest.configuration.properties), ["greeting"]);
    assert.equal(manifest.configuration.required, undefined);
    assert.equal(warnings.length, 0);
  });

  it("accepts canonical dotless listeners", () => {
    const pluginModule = {
      pluginSettingsSchema: {
        type: "object",
        properties: {
          greeting: { type: "string", default: "hello" },
        },
      },
      commandSchema: {
        ping: {
          description: "Ping command",
          "ubiquity:example": "/ping",
        },
      },
    };

    const { manifest, warnings } = buildManifest({}, pluginModule, { name: "test-plugin", description: "Test plugin" }, REPO_INFO, {
      supportedEvents: ["push"],
      knownWebhookEvents: new Set(["push", "issue_comment.created"]),
    });

    assert.deepEqual(manifest["ubiquity:listeners"], ["push"]);
    assert.ok(!warnings.some((warning) => warning.includes('manifest["ubiquity:listeners"]')));
  });

  it("warns but preserves unknown listeners when canonical list is available", () => {
    const pluginModule = {
      pluginSettingsSchema: {
        type: "object",
        properties: {
          greeting: { type: "string", default: "hello" },
        },
      },
      commandSchema: {
        ping: {
          description: "Ping command",
          "ubiquity:example": "/ping",
        },
      },
    };

    const { manifest, warnings } = buildManifest({}, pluginModule, { name: "test-plugin", description: "Test plugin" }, REPO_INFO, {
      supportedEvents: ["push", "future_event.created"],
      knownWebhookEvents: new Set(["push"]),
    });

    assert.deepEqual(manifest["ubiquity:listeners"], ["push", "future_event.created"]);
    assert.ok(warnings.some((warning) => warning.includes("unknown webhook event(s): future_event.created")));
    assert.ok(!warnings.some((warning) => warning.includes("supported events found but invalid")));
  });

  it("suppresses missing-command warning when TCommand is null", () => {
    const { manifest, warnings } = buildManifest(
      {},
      { pluginSettingsSchema: { type: "object", properties: {} } },
      { name: "test-plugin", description: "Test plugin" },
      REPO_INFO,
      {
        supportedEvents: ["issue_comment.created"],
        allowMissingCommandSchema: true,
      }
    );

    assert.equal(manifest.commands, undefined);
    assert.ok(!warnings.some((warning) => warning.includes("manifest.commands")));
  });

  it("warns and defaults skipBotEvents to true for invalid values", () => {
    const { manifest, warnings } = buildManifest({}, {}, null, REPO_INFO, { skipBotEvents: "invalid" });

    assert.equal(manifest.skipBotEvents, true);
    assert.ok(warnings.some((warning) => warning.includes("manifest.skipBotEvents") && warning.includes("invalid action input value")));
  });

  it("converts TypeBox union command schemas", () => {
    const { manifest, warnings } = buildManifest(
      {},
      {
        commandSchema: {
          anyOf: [
            {
              properties: {
                name: {
                  const: "start",
                  description: "Start command",
                  examples: ["/start"],
                },
              },
            },
          ],
        },
      },
      { name: "test-plugin", description: "Test plugin" },
      REPO_INFO,
      { supportedEvents: ["issue_comment.created"] }
    );

    assert.equal(manifest.commands.start.description, "Start command");
    assert.equal(manifest.commands.start["ubiquity:example"], "/start");
    assert.ok(!warnings.some((warning) => warning.includes("could not be converted")));
  });

  it("converts a single-object TypeBox command schema", () => {
    const { manifest, warnings } = buildManifest(
      {},
      {
        commandSchema: {
          type: "object",
          properties: {
            name: {
              const: "query",
              description: "Query user",
              examples: ["/query @UbiquityOS"],
            },
            parameters: {
              type: "object",
              properties: {
                username: { type: "string" },
              },
            },
          },
          required: ["name", "parameters"],
        },
      },
      { name: "test-plugin", description: "Test plugin" },
      REPO_INFO,
      { supportedEvents: ["issue_comment.created"] }
    );

    assert.equal(manifest.commands.query.description, "Query user");
    assert.equal(manifest.commands.query["ubiquity:example"], "/query @UbiquityOS");
    assert.ok(!warnings.some((warning) => warning.includes("manifest.commands")));
  });
});

describe("validation helpers", () => {
  it("validateCommands validates command map shapes", () => {
    assert.equal(
      validateCommands({
        hello: {
          description: "hello",
          "ubiquity:example": "/hello",
        },
      }),
      null
    );

    assert.ok(validateCommands(null).includes("plain object"));
    assert.ok(validateCommands({ bad: { description: "missing" } }).includes('"ubiquity:example"'));
  });

  it("convertTypeBoxCommandSchema reports invalid shapes", () => {
    const { commands, error } = convertTypeBoxCommandSchema({ anyOf: [] });
    assert.equal(commands, null);
    assert.ok(error.includes("anyOf/oneOf"));
  });

  it("convertTypeBoxCommandSchema converts single-object variant schemas", () => {
    const { commands, error } = convertTypeBoxCommandSchema({
      type: "object",
      properties: {
        name: {
          const: "query",
          description: "Query user",
          examples: ["/query @UbiquityOS"],
        },
        parameters: {
          type: "object",
          properties: {
            username: { type: "string" },
          },
        },
      },
      required: ["name", "parameters"],
    });

    assert.equal(error, null);
    assert.deepEqual(commands, {
      query: {
        description: "Query user",
        "ubiquity:example": "/query @UbiquityOS",
        parameters: {
          type: "object",
          properties: {
            username: { type: "string" },
          },
        },
      },
    });
  });

  it("validateListeners validates listener values and canonical unknowns", () => {
    assert.deepEqual(validateListeners(["issue_comment.created"]), {
      error: null,
      unknownEvents: [],
    });
    assert.ok(validateListeners("issue_comment.created").error.includes("array"));
    assert.ok(validateListeners([""]).error.includes("non-empty string"));
    assert.deepEqual(validateListeners(["push", "future_event.created"], { knownWebhookEvents: new Set(["push"]) }), {
      error: null,
      unknownEvents: ["future_event.created"],
    });
  });

  it("normalizes skipBotEvents values", () => {
    assert.deepEqual(normalizeSkipBotEvents(undefined), {
      value: true,
      warning: null,
    });
    assert.deepEqual(normalizeSkipBotEvents("false"), {
      value: false,
      warning: null,
    });
  });

  it("parses excluded supported events from comma separated input", () => {
    assert.deepEqual(parseExcludedSupportedEvents("issue_comment.created, pull_request.opened, issue_comment.created"), [
      "issue_comment.created",
      "pull_request.opened",
    ]);
    assert.deepEqual(parseExcludedSupportedEvents("   "), []);
  });
});

describe("source parsing helpers", () => {
  it("handles delimiter matching and top-level splitting", () => {
    const expression = "createPlugin<A, B, C, D>({}, {}, { settingsSchema: schema })";
    const genericStart = expression.indexOf("<");
    const genericEnd = findMatchingDelimiter(expression, genericStart, "<", ">");

    assert.equal(expression.slice(genericEnd, genericEnd + 1), ">");
    assert.deepEqual(
      splitTopLevel("A, B<C, D>, E", ",", { trackAngles: true }).map((part) => part.trim()),
      ["A", "B<C, D>", "E"]
    );
  });

  it("parses object literals with shorthand and explicit keys", () => {
    const parsed = parseObjectLiteral("({ settingsSchema: pluginSettingsSchema, commandSchema, ...rest })");

    assert.equal(parsed.properties.get("settingsSchema"), "pluginSettingsSchema");
    assert.equal(parsed.properties.get("commandSchema"), "commandSchema");
    assert.deepEqual(parsed.spreads, ["rest"]);
  });

  it("parses imports and type aliases", () => {
    const source = `import type { Foo as Bar } from "./types";
import Baz, { Qux } from "./module";
export type SupportedEvents = "issues.opened" | "issues.closed";
`;

    const imports = parseImports(source);
    const aliases = parseTypeAliases(source);

    assert.equal(imports.named.get("Bar").importedName, "Foo");
    assert.equal(imports.default.get("Baz"), "./module");
    assert.equal(imports.named.get("Qux").importedName, "Qux");
    assert.equal(aliases.get("SupportedEvents"), '"issues.opened" | "issues.closed"');
  });

  it("parses semicolonless type aliases", () => {
    const source = `export type SupportedEvents = "issues.opened" | "issues.closed"
export type NextAlias = "issues.labeled"
`;

    const aliases = parseTypeAliases(source);
    assert.equal(aliases.get("SupportedEvents"), '"issues.opened" | "issues.closed"');
    assert.equal(aliases.get("NextAlias"), '"issues.labeled"');
  });

  it("parses multiline object aliases without truncating inner semicolons", () => {
    const source = `type Config = {
  enabled: boolean;
  name: string;
}

type Mode = "on" | "off";
`;

    const aliases = parseTypeAliases(source);
    assert.ok(aliases.get("Config").includes("enabled: boolean;"));
    assert.ok(aliases.get("Config").includes("name: string;"));
    assert.equal(aliases.get("Mode"), '"on" | "off"');
  });

  it("resolves TypeScript module paths from relative imports", () => {
    const projectRoot = createProject("resolve-ts-path");
    const fromFile = writeProjectFile(projectRoot, "src/index.ts", "export const value = 1;");
    const target = writeProjectFile(projectRoot, "src/types/context.ts", 'export type SupportedEvents = "issues.opened";');

    assert.equal(resolveTsModulePath(fromFile, "./types/context"), target);
  });

  it("extracts callsites with explicit generics", () => {
    const source = `
createPlugin<A, B, C, D>({}, {}, { settingsSchema: schema });
createPlugin({}, {}, { settingsSchema: schema });
`;

    const callsites = findCallsitesInSource("worker.ts", source, "createPlugin");
    assert.equal(callsites.length, 1);
    assert.deepEqual(callsites[0].genericArgs, ["A", "B", "C", "D"]);
  });

  it("parses StaticDecode/Static aliases", () => {
    assert.equal(parseStaticDecodeTypeAlias("StaticDecode<typeof commandSchema>"), "commandSchema");
    assert.equal(parseStaticDecodeTypeAlias("TypeBox.Static<typeof cmdSchema>"), "cmdSchema");
    assert.equal(parseStaticDecodeTypeAlias("{ foo: string }"), null);
  });
});

describe("entrypoint discovery and metadata extraction", () => {
  it("extracts settings schema, command schema and supported events from createPlugin", async () => {
    const projectRoot = createProject("metadata-create-plugin");
    scaffoldStandardPlugin(projectRoot);

    const metadata = await extractManifestMetadataFromEntrypoint(projectRoot);

    assert.equal(metadata.entrypoint.functionName, "createPlugin");
    assert.equal(metadata.allowMissingCommandSchema, false);
    assert.deepEqual(metadata.excludedSupportedEvents, []);
    assert.deepEqual(metadata.pluginSettingsSchema, {
      type: "object",
      properties: {
        greeting: { type: "string", default: "hello" },
      },
      required: ["greeting"],
    });
    assert.deepEqual(metadata.commandSchema, {
      start: {
        description: "Start command",
        "ubiquity:example": "/start",
      },
    });
    assert.deepEqual(metadata.supportedEvents, ["issue_comment.created", "pull_request.opened", "issues.labeled"]);
  });

  it("extracts settings schema when createPlugin options provide it through object spread", async () => {
    const projectRoot = createProject("metadata-settings-schema-spread");
    scaffoldStandardPlugin(projectRoot, {
      entrypointSource: `import { createPlugin } from "@ubiquity-os/plugin-sdk/worker";
import { pluginRuntimeSchemas } from "./runtime-options";
import type {
  PluginConfig,
  PluginContext,
  CommandInput,
  SupportedEvents,
} from "./types";

export const plugin = createPlugin<
  PluginConfig,
  PluginContext,
  CommandInput,
  SupportedEvents
>(
  {},
  {},
  {
    postCommentOnError: true,
    ...pluginRuntimeSchemas,
  },
);
`,
    });
    writeProjectFile(
      projectRoot,
      "src/runtime-options.ts",
      `import { settingsRuntimeSchema } from "./schemas.mjs";

export const pluginRuntimeSchemas = {
  settingsSchema: settingsRuntimeSchema,
};
`
    );

    const metadata = await extractManifestMetadataFromEntrypoint(projectRoot);

    assert.deepEqual(metadata.pluginSettingsSchema, {
      type: "object",
      properties: {
        greeting: { type: "string", default: "hello" },
      },
      required: ["greeting"],
    });
  });

  it("resolves settingsSchema with last-write-wins precedence across direct keys and spreads", async () => {
    const projectRoot = createProject("metadata-settings-schema-spread-override-order");
    scaffoldStandardPlugin(projectRoot, {
      entrypointSource: `import { createPlugin } from "@ubiquity-os/plugin-sdk/worker";
import { baseSettingsSchema } from "./schemas.mjs";
import { runtimeOverrides } from "./runtime-options";
import type {
  PluginConfig,
  PluginContext,
  CommandInput,
  SupportedEvents,
} from "./types";

export const plugin = createPlugin<
  PluginConfig,
  PluginContext,
  CommandInput,
  SupportedEvents
>(
  {},
  {},
  {
    settingsSchema: baseSettingsSchema,
    ...runtimeOverrides,
  },
);
`,
      schemasSource: `export const settingsRuntimeSchema = {
  type: "object",
  properties: {
    greeting: { type: "string", default: "hello" }
  },
  required: ["greeting"]
};

export const baseSettingsSchema = {
  type: "object",
  properties: {
    source: { type: "string", default: "base" }
  },
  required: ["source"]
};

export const commandRuntimeSchema = {
  start: {
    description: "Start command",
    "ubiquity:example": "/start"
  }
};
`,
    });
    writeProjectFile(
      projectRoot,
      "src/runtime-options.ts",
      `export const runtimeOverrides = {
  settingsSchema: {
    type: "object",
    properties: {
      source: { type: "string", default: "spread" }
    },
    required: ["source"]
  }
};
`
    );

    const metadata = await extractManifestMetadataFromEntrypoint(projectRoot);

    assert.deepEqual(metadata.pluginSettingsSchema, {
      type: "object",
      properties: {
        source: { type: "string", default: "spread" },
      },
      required: ["source"],
    });
  });

  it("fails when a higher-precedence spread cannot be resolved", async () => {
    const projectRoot = createProject("metadata-settings-schema-unresolvable-higher-spread");
    scaffoldStandardPlugin(projectRoot, {
      entrypointSource: `import { createPlugin } from "@ubiquity-os/plugin-sdk/worker";
import { pluginRuntimeSchemas, getRuntimeSchemas } from "./runtime-options";
import type {
  PluginConfig,
  PluginContext,
  CommandInput,
  SupportedEvents,
} from "./types";

export const plugin = createPlugin<
  PluginConfig,
  PluginContext,
  CommandInput,
  SupportedEvents
>(
  {},
  {},
  {
    ...pluginRuntimeSchemas,
    ...getRuntimeSchemas(),
  },
);
`,
    });
    writeProjectFile(
      projectRoot,
      "src/runtime-options.ts",
      `import { settingsRuntimeSchema } from "./schemas.mjs";

export const pluginRuntimeSchemas = {
  settingsSchema: settingsRuntimeSchema,
};

export function getRuntimeSchemas() {
  return {
    settingsSchema: {
      type: "object",
      properties: {
        source: { type: "string", default: "runtime" }
      },
      required: ["source"]
    }
  };
}
`
    );

    await assert.rejects(
      () => extractManifestMetadataFromEntrypoint(projectRoot),
      /Could not resolve higher-precedence spread "getRuntimeSchemas\(\)" while resolving "settingsSchema"/i
    );
  });

  it("uses createActionsPlugin when createPlugin is absent", async () => {
    const projectRoot = createProject("metadata-create-actions-plugin");
    scaffoldStandardPlugin(projectRoot, {
      entrypointSource: `import { createActionsPlugin } from "@ubiquity-os/plugin-sdk/worker";
import { settingsRuntimeSchema } from "./schemas.mjs";
import type {
  PluginConfig,
  PluginContext,
  CommandInput,
  SupportedEvents,
} from "./types";

export const plugin = createActionsPlugin<
  PluginConfig,
  PluginContext,
  CommandInput,
  SupportedEvents
>(
  {},
  {
    settingsSchema: settingsRuntimeSchema,
  },
);
`,
    });

    const metadata = await extractManifestMetadataFromEntrypoint(projectRoot);
    assert.equal(metadata.entrypoint.functionName, "createActionsPlugin");
    assert.deepEqual(metadata.supportedEvents, ["issue_comment.created", "pull_request.opened", "issues.labeled"]);
  });

  it("prefers createPlugin when both entrypoint styles are present", async () => {
    const projectRoot = createProject("entrypoint-preference");
    scaffoldStandardPlugin(projectRoot);
    writeProjectFile(
      projectRoot,
      "src/actions.ts",
      `import { createActionsPlugin } from "@ubiquity-os/plugin-sdk/worker";
import type { PluginConfig, PluginContext, CommandInput, SupportedEvents } from "./types";
import { settingsRuntimeSchema } from "./schemas.mjs";

export const actions = createActionsPlugin<
  PluginConfig,
  PluginContext,
  CommandInput,
  SupportedEvents
>({}, { settingsSchema: settingsRuntimeSchema });
`
    );

    const callsite = await findEntrypointCallsite(projectRoot);
    assert.equal(callsite.functionName, "createPlugin");
    assert.ok(callsite.filePath.endsWith(path.join("src", "worker.ts")));
  });

  it("applies excludeSupportedEvents and removes exact matches", async () => {
    const projectRoot = createProject("exclude-events");
    scaffoldStandardPlugin(projectRoot);

    const metadata = await extractManifestMetadataFromEntrypoint(projectRoot, "issues.labeled, pull_request.opened");

    assert.deepEqual(metadata.excludedSupportedEvents, ["issues.labeled", "pull_request.opened"]);
    assert.deepEqual(metadata.supportedEvents, ["issue_comment.created"]);
  });

  it("fails when excludeSupportedEvents contains unknown names", async () => {
    const projectRoot = createProject("exclude-unknown");
    scaffoldStandardPlugin(projectRoot);

    await assert.rejects(() => extractManifestMetadataFromEntrypoint(projectRoot, "issues.labeled,unknown.event"), /unknown event\(s\): unknown\.event/i);
  });

  it("allows TCommand = null and skips command schema extraction", async () => {
    const projectRoot = createProject("command-null");
    scaffoldStandardPlugin(projectRoot, {
      entrypointSource: `import { createPlugin } from "@ubiquity-os/plugin-sdk/worker";
import { settingsRuntimeSchema } from "./schemas.mjs";
import type { PluginConfig, PluginContext, SupportedEvents } from "./types";

export const plugin = createPlugin<
  PluginConfig,
  PluginContext,
  null,
  SupportedEvents
>(
  {},
  {},
  {
    settingsSchema: settingsRuntimeSchema,
  },
);
`,
    });

    const metadata = await extractManifestMetadataFromEntrypoint(projectRoot);

    assert.equal(metadata.allowMissingCommandSchema, true);
    assert.equal(metadata.commandSchema, undefined);
  });

  it("resolves supported events from a direct union generic", async () => {
    const projectRoot = createProject("direct-union-events");
    scaffoldStandardPlugin(projectRoot, {
      entrypointSource: `import { createPlugin } from "@ubiquity-os/plugin-sdk/worker";
import { settingsRuntimeSchema } from "./schemas.mjs";
import type { PluginConfig, PluginContext } from "./types";

export const plugin = createPlugin<
  PluginConfig,
  PluginContext,
  null,
  "issue_comment.created" | "pull_request.opened"
>(
  {},
  {},
  {
    settingsSchema: settingsRuntimeSchema,
  },
);
`,
    });

    const metadata = await extractManifestMetadataFromEntrypoint(projectRoot);
    assert.deepEqual(metadata.supportedEvents, ["issue_comment.created", "pull_request.opened"]);
  });

  it("fails on multiple createPlugin callsites", async () => {
    const projectRoot = createProject("multiple-create-plugin");
    scaffoldStandardPlugin(projectRoot);
    writeProjectFile(
      projectRoot,
      "src/secondary.ts",
      `import { createPlugin } from "@ubiquity-os/plugin-sdk/worker";
import { settingsRuntimeSchema } from "./schemas.mjs";
import type { PluginConfig, PluginContext, CommandInput, SupportedEvents } from "./types";

export const plugin2 = createPlugin<
  PluginConfig,
  PluginContext,
  CommandInput,
  SupportedEvents
>({}, {}, { settingsSchema: settingsRuntimeSchema });
`
    );

    await assert.rejects(() => findEntrypointCallsite(projectRoot), /Multiple createPlugin callsites detected/i);
  });

  it("fails when no explicit generic entrypoint callsite exists", async () => {
    const projectRoot = createProject("no-explicit-generics");
    writeProjectFile(
      projectRoot,
      "src/worker.ts",
      `import { createPlugin } from "@ubiquity-os/plugin-sdk/worker";

createPlugin({}, {}, { settingsSchema: {} });
`
    );

    await assert.rejects(() => findEntrypointCallsite(projectRoot), /No createPlugin<\.\.\.>\(\.\.\.\) or createActionsPlugin<\.\.\.>\(\.\.\.\) callsite/i);
  });

  it("fails when settingsSchema is missing in options", async () => {
    const projectRoot = createProject("missing-settings-schema");
    scaffoldStandardPlugin(projectRoot, {
      entrypointSource: `import { createPlugin } from "@ubiquity-os/plugin-sdk/worker";
import { settingsRuntimeSchema } from "./schemas.mjs";
import type {
  PluginConfig,
  PluginContext,
  CommandInput,
  SupportedEvents,
} from "./types";

export const plugin = createPlugin<
  PluginConfig,
  PluginContext,
  CommandInput,
  SupportedEvents
>(
  {},
  {},
  {
    schema: settingsRuntimeSchema,
  },
);
`,
    });

    await assert.rejects(
      () => extractManifestMetadataFromEntrypoint(projectRoot),
      /must include a resolvable "settingsSchema" property \(directly or via object spread\)/i
    );
  });

  it("fails when command type alias is not StaticDecode/Static<typeof ...>", async () => {
    const projectRoot = createProject("invalid-command-alias");
    scaffoldStandardPlugin(projectRoot, {
      typesSource: `export type PluginConfig = { enabled: boolean };
export type PluginContext = { eventName: string };
export type CommandInput = { foo: string };
export type SupportedEvents = "issue_comment.created" | "pull_request.opened";
`,
    });

    await assert.rejects(() => extractManifestMetadataFromEntrypoint(projectRoot), /must be declared as StaticDecode<typeof X> or Static<typeof X>/i);
  });

  it("fails when supported events cannot be resolved to string literals", async () => {
    const projectRoot = createProject("invalid-supported-events");
    scaffoldStandardPlugin(projectRoot, {
      typesSource: `import type { StaticDecode } from "@sinclair/typebox";
import { commandRuntimeSchema } from "./schemas.mjs";

export type PluginConfig = { enabled: boolean };
export type PluginContext = { eventName: string };
export type CommandInput = StaticDecode<typeof commandRuntimeSchema>;
export type SupportedEvents = number;
`,
    });

    await assert.rejects(() => extractManifestMetadataFromEntrypoint(projectRoot), /Could not resolve type alias "number"|not a string-literal union/i);
  });
});

describe("cross-file type and runtime resolution", () => {
  it("resolves supported events from imported type aliases", async () => {
    const projectRoot = createProject("supported-events-imported-alias");
    writeProjectFile(
      projectRoot,
      "src/schemas.mjs",
      `export const settingsRuntimeSchema = { type: "object", properties: {} };
export const commandRuntimeSchema = {
  ping: { description: "Ping", "ubiquity:example": "/ping" }
};
`
    );
    writeProjectFile(
      projectRoot,
      "src/events.ts",
      `export type AppEvents =
  | "issue_comment.created"
  | "issues.labeled";
`
    );
    writeProjectFile(
      projectRoot,
      "src/types.ts",
      `import type { StaticDecode } from "@sinclair/typebox";
import { commandRuntimeSchema } from "./schemas.mjs";
import type { AppEvents } from "./events";

export type PluginConfig = {};
export type PluginContext = {};
export type CommandInput = StaticDecode<typeof commandRuntimeSchema>;
export type SupportedEvents = AppEvents;
`
    );
    writeProjectFile(
      projectRoot,
      "src/worker.ts",
      `import { createPlugin } from "@ubiquity-os/plugin-sdk/worker";
import { settingsRuntimeSchema } from "./schemas.mjs";
import type { PluginConfig, PluginContext, CommandInput, SupportedEvents } from "./types";

export const plugin = createPlugin<
  PluginConfig,
  PluginContext,
  CommandInput,
  SupportedEvents
>({}, {}, { settingsSchema: settingsRuntimeSchema });
`
    );

    const metadata = await extractManifestMetadataFromEntrypoint(projectRoot);
    assert.deepEqual(metadata.supportedEvents, ["issue_comment.created", "issues.labeled"]);
  });

  it("resolves runtime references from namespace imports", async () => {
    const projectRoot = createProject("namespace-runtime-reference");
    const filePath = writeProjectFile(
      projectRoot,
      "src/worker.ts",
      `import * as Schemas from "./schemas.mjs";
export const value = Schemas.settingsRuntimeSchema;
`
    );
    writeProjectFile(projectRoot, "src/schemas.mjs", `export const settingsRuntimeSchema = { type: "object", properties: {} };`);

    const cache = new Map();
    const resolved = await resolveRuntimeReferenceFromIdentifier("Schemas.settingsRuntimeSchema", filePath, projectRoot, cache);

    assert.ok(resolved.modulePath.endsWith(path.join("src", "schemas.mjs")));
    assert.equal(resolved.exportName, "settingsRuntimeSchema");
  });

  it("resolves supported event unions from type expressions", async () => {
    const projectRoot = createProject("supported-events-expression");
    const filePath = writeProjectFile(
      projectRoot,
      "src/types.ts",
      `export type SupportedEvents =
  | "issue_comment.created"
  | "pull_request.opened";
`
    );

    const cache = new Map();
    const events = await resolveSupportedEventsFromTypeExpression("SupportedEvents", filePath, projectRoot, cache);

    assert.deepEqual(events, ["issue_comment.created", "pull_request.opened"]);
  });

  it("resolves supported event unions with apostrophes in string literals", async () => {
    const projectRoot = createProject("supported-events-apostrophe");
    const filePath = writeProjectFile(projectRoot, "src/types.ts", "export type Dummy = true;\n");

    const cache = new Map();
    const events = await resolveSupportedEventsFromTypeExpression(`"it's.opened" | 'issues.closed'`, filePath, projectRoot, cache);

    assert.deepEqual(events, ["it's.opened", "issues.closed"]);
  });
});

describe("misc utility behavior", () => {
  it("parses repository from common remote URL formats", () => {
    assert.equal(parseRepositoryFromRemoteUrl("https://github.com/ubiquity-os/plugin-manifest-tool.git"), "ubiquity-os/plugin-manifest-tool");
    assert.equal(parseRepositoryFromRemoteUrl("git@github.com:ubiquity-os/plugin-manifest-tool.git"), "ubiquity-os/plugin-manifest-tool");
    assert.equal(parseRepositoryFromRemoteUrl("ssh://git@github.com/ubiquity-os/plugin-manifest-tool"), "ubiquity-os/plugin-manifest-tool");
    assert.equal(parseRepositoryFromRemoteUrl("not-a-valid-remote"), null);
  });

  it("parses ref names from github refs", () => {
    assert.equal(parseRefNameFromGitHubRef("refs/heads/feat/test"), "feat/test");
    assert.equal(parseRefNameFromGitHubRef("refs/tags/v1.0.0"), "v1.0.0");
    assert.equal(parseRefNameFromGitHubRef("feat/direct"), "feat/direct");
    assert.equal(parseRefNameFromGitHubRef(undefined), null);
  });

  it("resolves config without requiring CI env variables", () => {
    const projectRoot = createProject("resolve-config-defaults");
    const config = resolveConfig({
      argv: ["node", "plugin-manifest-tool.js"],
      env: {},
      cwd: projectRoot,
      getRepositoryFromGit: () => "ubiquity-os/example-plugin",
      getRefNameFromGit: () => "feat/my-branch",
    });

    assert.equal(config.projectRoot, projectRoot);
    assert.equal(config.manifestPath, path.join(projectRoot, "manifest.json"));
    assert.equal(config.repository, "ubiquity-os/example-plugin");
    assert.equal(config.refName, "feat/my-branch");
    assert.equal(config.skipBotEvents, "true");
    assert.equal(config.excludeSupportedEvents, "");
  });

  it("resolves config from env overrides when provided", () => {
    const projectRoot = createProject("resolve-config-env");
    const config = resolveConfig({
      argv: ["node", "plugin-manifest-tool.js"],
      env: {
        MANIFEST_PATH: "out/manifest.json",
        GITHUB_WORKSPACE: projectRoot,
        GITHUB_REPOSITORY: "ubiquity-os/override-plugin",
        GITHUB_REF: "refs/heads/feature/env-ref",
        SKIP_BOT_EVENTS: "false",
        EXCLUDE_SUPPORTED_EVENTS: "issue_comment.created",
      },
      cwd: "/tmp/unused",
      getRepositoryFromGit: () => "ignored/repository",
      getRefNameFromGit: () => "ignored-ref",
    });

    assert.equal(config.projectRoot, projectRoot);
    assert.equal(config.manifestPath, path.join(projectRoot, "out/manifest.json"));
    assert.equal(config.repository, "ubiquity-os/override-plugin");
    assert.equal(config.refName, "feature/env-ref");
    assert.equal(config.skipBotEvents, "false");
    assert.equal(config.excludeSupportedEvents, "issue_comment.created");
  });

  it("pickManifestExports supports named and default object exports", () => {
    assert.deepEqual(
      pickManifestExports({
        pluginSettingsSchema: { type: "object" },
        commandSchema: { ping: { description: "Ping", "ubiquity:example": "/ping" } },
      }),
      {
        pluginSettingsSchema: { type: "object" },
        commandSchema: { ping: { description: "Ping", "ubiquity:example": "/ping" } },
      }
    );

    assert.deepEqual(
      pickManifestExports({
        default: {
          pluginSettingsSchema: { type: "object" },
        },
      }),
      { pluginSettingsSchema: { type: "object" } }
    );
  });

  it("parses deno loader payload output", () => {
    const parsed = parseDenoLoaderOutput(["noise", '__CODEX_MANIFEST_EXPORTS__{"pluginSettingsSchema":{"type":"object"}}'].join("\n"));

    assert.deepEqual(parsed, {
      pluginSettingsSchema: { type: "object" },
    });
  });

  it("orders manifest fields deterministically", () => {
    const ordered = orderManifestFields({
      description: "desc",
      short_name: "repo@ref",
      skipBotEvents: true,
      name: "plugin",
      custom: true,
    });

    assert.deepEqual(Object.keys(ordered), ["name", "short_name", "description", "skipBotEvents", "custom"]);
  });

  it("customReviver removes defaulted properties from required arrays", () => {
    const input = {
      type: "object",
      properties: {
        a: { type: "string", default: "x" },
        b: { type: "string" },
      },
      required: ["a", "b"],
    };

    const revived = JSON.parse(JSON.stringify(input), customReviver);
    assert.deepEqual(revived.required, ["b"]);
  });

  it("injects and preserves Deno shim behavior", () => {
    const hadDeno = Object.prototype.hasOwnProperty.call(globalThis, "Deno");
    const previous = globalThis.Deno;
    if (hadDeno) {
      delete globalThis.Deno;
    }

    try {
      const injected = ensureNodeDenoShim();
      assert.equal(injected, true);
      assert.equal(typeof globalThis.Deno.cwd, "function");
      assert.equal(typeof globalThis.Deno.env.get, "function");

      const reinjected = ensureNodeDenoShim();
      assert.equal(reinjected, false);
    } finally {
      delete globalThis.Deno;
      if (hadDeno) {
        globalThis.Deno = previous;
      }
    }
  });

  it("resolveDenoCommand honors PLUGIN_MANIFEST_DENO_BIN override", () => {
    const previous = process.env.PLUGIN_MANIFEST_DENO_BIN;
    process.env.PLUGIN_MANIFEST_DENO_BIN = "/tmp/custom-deno";

    try {
      assert.deepEqual(resolveDenoCommand(), {
        command: "/tmp/custom-deno",
        argsPrefix: [],
        source: "env",
      });
    } finally {
      if (previous === undefined) {
        delete process.env.PLUGIN_MANIFEST_DENO_BIN;
      } else {
        process.env.PLUGIN_MANIFEST_DENO_BIN = previous;
      }
    }
  });

  it("isMissingExecutableError detects ENOENT-style failures", () => {
    assert.equal(isMissingExecutableError({ code: "ENOENT" }), true);
    assert.equal(isMissingExecutableError(new Error("spawn deno ENOENT")), true);
    assert.equal(isMissingExecutableError(new Error("syntax error")), false);
  });
});
