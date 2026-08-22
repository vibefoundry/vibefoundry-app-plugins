"use strict";
/*
 * Track 0 — answering questions about the user's own data.
 *
 * The tool definitions and the result shaping for the six data tools. The
 * relaying itself lives in index.js because it needs the same folder resolution
 * and backend adoption every other tool uses.
 *
 * This file holds no credential and names no gateway. Every one of these tools
 * ends in a loopback call to the python package's /api/org/*, and the package
 * is the only thing that has ever seen the org key. Nothing here is logged
 * either: the ring buffer behind the pane's Logs button is copyable by the
 * user, and a SQL string with a customer name in it does not belong in it.
 */

// The backend release that first served /api/rules and re-authenticated itself.
// Older ones answer 404, or worse answer something else on the same path, so
// this is checked against /api/health BEFORE any org call rather than after one
// fails.
const MIN_BACKEND_VERSION = "0.6.0";

const UPGRADE_TEXT =
  "VibeFoundry needs an update before it can answer questions about data — tell " +
  'the user to say "set me up to vibe code" and call setup_vibefoundry, then try ' +
  "this again.";

// A personal credential lasts an hour, so an afternoon's work crosses at least
// one expiry. The backend re-opens the sign-in page itself; these are how long
// the plugin is willing to stand there waiting for the user to finish it. The
// host's tool timeout is 1800s, so 120 is nowhere near it.
const REAUTH_TIMEOUT_MS = 120 * 1000;
const REAUTH_POLL_MS = 1500;

function reauthPendingText(orgId) {
  return (
    `The connection to ${orgId || "that organization"} expired, so VibeFoundry opened the ` +
    "sign-in page in the user's browser. It is still waiting there — tell them to finish " +
    "signing in, then ask me again and I'll run this."
  );
}

/** Did that org come back connected? /api/org/status is shaped by the python
 * package and has been a list and a map at different points; both are read here
 * rather than betting the poll on one of them. */
function orgConnected(json, orgId) {
  // /api/org/status answers {"organizations": [...]} and prunes expired
  // credentials before replying, so presence in that list IS connectedness —
  // there is no per-entry flag to read. This read `json.orgs`, a shape the
  // backend has never returned, so it was always false and awaitReconnect()
  // polled for the full two minutes on every re-auth instead of retrying.
  // One documented shape, read directly: a tolerant chain is what hid this.
  if (!json || !orgId) return false;
  const list = json.organizations;
  return Array.isArray(list) && list.some((o) => o && String(o.org_id) === orgId);
}

// What crosses the bridge, and why the two numbers differ. The text is read by
// a model in one glance, so 50 rows is already more than an answer needs; the
// structured copy is what a caller pages through, and 500 is where it stops
// being a result and starts being a download.
const TEXT_ROWS = 50;
const STRUCTURED_ROWS = 500;
const CELL_CHARS = 120;
// One enormous JSON value crossing the host bridge aborts V8 and takes the
// desktop app down with it — the same failure "Add data" hit before uploads
// were chunked. A 500-row result of wide text columns gets there easily, so
// rows are dropped until the payload fits.
const STRUCTURED_BYTES = 512 * 1024;

const say = (text, structured) => ({
  content: [{ type: "text", text }],
  structuredContent: structured || {},
});

/** Semver-ish compare against MIN_BACKEND_VERSION. An unreadable version is
 * treated as too old: guessing "probably fine" is how a 404 reaches a model. */
function versionAtLeast(version, min) {
  const parts = (s) =>
    String(s || "")
      .trim()
      .replace(/^v/, "")
      .split(/[.\-+]/)
      .slice(0, 3)
      .map((n) => parseInt(n, 10) || 0);
  const a = parts(version);
  const b = parts(min);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return true;
}

// --- tool definitions ---------------------------------------------------------
// These descriptions are prompts, not documentation: they are the only thing
// telling a model to look at the user's real data instead of answering from
// memory, and to write one narrow query instead of downloading a table.

const PROJECT_ROOT_PROPERTY = {
  type: "string",
  description:
    "Absolute path of the CURRENT workspace — the folder this conversation is " +
    "working in. Take it from context; never ask the user for it and never reuse " +
    "one from an earlier conversation. Used only when the host does not report a " +
    "workspace root of its own; when it does, that root wins and this is ignored.",
};

const CONNECT_TOOL = {
  name: "connect_organization",
  title: "Connect Organization",
  description:
    "Connect this machine to the user's organization so their tables become " +
    "queryable. Call it whenever the user asks to connect to, sign in to or link " +
    "their organization, their company data, their data hub or their portal — and " +
    "whenever data_catalog, data_schema, data_query or data_pull report that " +
    "nothing is connected. It opens the Organizations panel in the VibeFoundry " +
    "pane and sends the user to their own organization's sign-in page in a " +
    "browser; they approve there and the connection completes itself. NEVER ask " +
    "the user for an API key, an app id, a secret or a .env file, and never write " +
    "one: this tool is the only way credentials are obtained, they are stored by " +
    "VibeFoundry on the user's machine, and neither you nor this plugin ever sees " +
    "them.",
  inputSchema: {
    type: "object",
    properties: {
      projectRoot: PROJECT_ROOT_PROPERTY,
      org_id: {
        type: "string",
        description:
          "Which organization to sign in to, from data_catalog or from a previous " +
          "connect_organization listing. Omit it to show the user the list and let " +
          "them pick in the pane.",
      },
    },
    required: ["projectRoot"],
  },
  annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true, readOnlyHint: false },
};

const CATALOG_TOOL = {
  name: "data_catalog",
  title: "List Available Data",
  description:
    "List every table the user can actually query: their connected " +
    "organization's tables plus the public datasets. Call this FIRST — before " +
    "answering anything about the user's data — whenever they ask what data they " +
    "have, what tables exist, whether some subject is covered, or ask a question " +
    "you would otherwise answer from memory or by guessing a table name. Never " +
    "invent a table name: this catalogue is the only source of truth for what " +
    "exists, and the org_id and table id it returns are exactly what data_schema, " +
    "data_query and data_pull take.",
  inputSchema: {
    type: "object",
    properties: { projectRoot: PROJECT_ROOT_PROPERTY },
    required: ["projectRoot"],
  },
  annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true, readOnlyHint: true },
};

const SCHEMA_TOOL = {
  name: "data_schema",
  title: "Profile A Table",
  description:
    "Profile one table before you write SQL against it: its exact column names " +
    "and types, null counts, sample values for categorical columns, ranges for " +
    "numeric ones, and when it was last refreshed. Call this after data_catalog " +
    "and before EVERY data_query — column names are not guessable, and a query " +
    "written from a guessed name simply fails. Read the per-column notes: they " +
    "say what a column actually means, which is usually not what its name " +
    "suggests.",
  inputSchema: {
    type: "object",
    properties: {
      projectRoot: PROJECT_ROOT_PROPERTY,
      org_id: {
        type: "string",
        description: 'The org_id from data_catalog. Public datasets use "public".',
      },
      table_id: { type: "string", description: "The table id from data_catalog, exactly as it appeared." },
    },
    required: ["projectRoot", "org_id", "table_id"],
  },
  annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true, readOnlyHint: true },
};

const QUERY_TOOL = {
  name: "data_query",
  title: "Query Data",
  description:
    "Answer a question about the user's data by running one read-only SQL SELECT " +
    "where the data lives and getting the rows back. This is how questions get " +
    "answered — use it instead of downloading a table, instead of writing a " +
    "script, and instead of answering from memory. Call data_schema on every " +
    "table you reference first, then write the NARROWEST query that answers the " +
    "question: name only the columns you need, do the filtering and the " +
    "aggregation in SQL, and add an ORDER BY and a LIMIT. Never write SELECT * — " +
    "a whole table is not an answer, and pulling one is slow and wasteful. One " +
    "statement only: no comments, no semicolon-separated statements, no writes or " +
    "DDL of any kind. Report the answer in the chat and say which table it came " +
    "from.",
  inputSchema: {
    type: "object",
    properties: {
      projectRoot: PROJECT_ROOT_PROPERTY,
      org_id: {
        type: "string",
        description: 'The org_id from data_catalog. Public datasets use "public".',
      },
      sql: {
        type: "string",
        description:
          "One SELECT (or WITH … SELECT) statement, referring to tables by the id " +
          "data_catalog gave and to columns by the names data_schema gave. Aggregate " +
          "and filter here rather than in your head.",
      },
      limit: {
        type: "integer",
        description:
          "Optional cap on rows returned. The server's own cap always wins. Prefer a " +
          "LIMIT inside the SQL.",
      },
    },
    required: ["projectRoot", "org_id", "sql"],
  },
  annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true, readOnlyHint: true },
};

const PULL_TOOL = {
  name: "data_pull",
  title: "Pull Data Into The Project",
  description:
    "Save a cut of a table into the project's input_folder/ so a Track 1–4 app " +
    "can read it from disk. Call this only when the user is BUILDING something " +
    "that needs the rows locally — a pipeline, a dashboard, an agent. To answer a " +
    "question, use data_query instead; this tool writes a file and answers " +
    "nothing. Pass a `sql` SELECT so only the rows and columns the app needs land " +
    "on disk, and omit it only when the app genuinely needs the whole table.",
  inputSchema: {
    type: "object",
    properties: {
      projectRoot: PROJECT_ROOT_PROPERTY,
      org_id: {
        type: "string",
        description: 'The org_id from data_catalog. Public datasets use "public".',
      },
      table_id: { type: "string", description: "The table id from data_catalog, exactly as it appeared." },
      sql: {
        type: "string",
        description:
          "Optional SELECT narrowing what gets written. Omit only when the app needs " +
          "the entire table.",
      },
      filename: {
        type: "string",
        description: "Optional name for the file in input_folder/. Defaults to the table id.",
      },
      script_name: {
        type: "string",
        description:
          "The script folder this pull belongs to, when you are building one. The cut " +
          "lands in app_folder/scripts/<script_name>/raw_pulls/ instead of input_folder/, " +
          "beside the steps that read it. Omit it only when the file is for the project " +
          "at large rather than for one script.",
      },
    },
    required: ["projectRoot", "org_id", "table_id"],
  },
  annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true, readOnlyHint: false },
};

const RULES_TOOL = {
  name: "vibefoundry_rules",
  title: "VibeFoundry Project Rules",
  description:
    "Re-read the rules for working in a VibeFoundry project: where a script, the " +
    "data it pulls and the answer it produces each belong. You normally do NOT " +
    "need to call this — the rules arrive on their own, attached to the first " +
    "VibeFoundry tool result of the conversation. Call it when that was many turns " +
    "ago and you are about to build or change something, or when you are unsure " +
    "where a file belongs. It returns the project's own rulebook when the project " +
    "has one, so what comes back is this project's rules rather than a remembered " +
    "version of them.",
  inputSchema: {
    type: "object",
    properties: { projectRoot: PROJECT_ROOT_PROPERTY },
    required: ["projectRoot"],
  },
  annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true, readOnlyHint: true },
};

/** The six tools, with the pane widget attached to the only one that shows a
 * pane. `widgetMeta` comes from index.js, which owns the widget URIs. */
function dataTools(widgetMeta) {
  return [{ ...CONNECT_TOOL, _meta: widgetMeta }, CATALOG_TOOL, SCHEMA_TOOL, QUERY_TOOL, PULL_TOOL, RULES_TOOL];
}

const DATA_TOOL_NAMES = new Set([
  CONNECT_TOOL.name,
  CATALOG_TOOL.name,
  SCHEMA_TOOL.name,
  QUERY_TOOL.name,
  PULL_TOOL.name,
  RULES_TOOL.name,
]);

const RULES_TOOL_NAME = RULES_TOOL.name;

// --- shaping a result a model can read ----------------------------------------

function cell(v) {
  if (v === null || v === undefined) return "";
  let s = typeof v === "object" ? JSON.stringify(v) : String(v);
  // Newlines and pipes both break a markdown table row, and a table the model
  // cannot parse is worse than no table.
  s = s.replace(/\s+/g, " ").replace(/\|/g, "\\|");
  return s.length > CELL_CHARS ? s.slice(0, CELL_CHARS - 1) + "…" : s;
}

function num(n) {
  return typeof n === "number" && Number.isFinite(n) ? n.toLocaleString("en-US") : String(n);
}

function markdownTable(columns, rows) {
  if (!columns.length) return "(the query returned no columns)";
  const head = `| ${columns.map(cell).join(" | ")} |`;
  const rule = `| ${columns.map(() => "---").join(" | ")} |`;
  return [head, rule, ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`)].join("\n");
}

/** Column names, whether the source gave names, objects, or only rows. */
function normaliseColumns(payload, rawRows) {
  const c = payload && payload.columns;
  if (Array.isArray(c) && c.length) {
    return c.map((x) => (x && typeof x === "object" ? String(x.name ?? x.column ?? "") : String(x)));
  }
  const first = rawRows && rawRows[0];
  return first && !Array.isArray(first) && typeof first === "object" ? Object.keys(first) : [];
}

/** Rows arrive as arrays (the gateway's shape) or as objects (polars to_dicts
 * on the public path). Everything downstream sees arrays. */
function normaliseRows(rawRows, columns) {
  if (!Array.isArray(rawRows)) return [];
  return rawRows.map((r) => (Array.isArray(r) ? r : columns.map((k) => (r ? r[k] : null))));
}

/** Trim rows until the structured payload can survive the host bridge. */
function fitRows(rows) {
  let out = rows.slice(0, STRUCTURED_ROWS);
  while (out.length > 1 && JSON.stringify(out).length > STRUCTURED_BYTES) {
    out = out.slice(0, Math.floor(out.length / 2));
  }
  return out;
}

function catalogItems(json) {
  if (Array.isArray(json)) return json;
  for (const key of ["tables", "catalog", "datasets", "items"]) {
    if (json && Array.isArray(json[key])) return json[key];
  }
  return [];
}

function catalogResult(json) {
  const items = catalogItems(json);
  if (!items.length) {
    return say(
      "No tables are available yet — no organization is connected and no public " +
        "dataset came back. Call connect_organization to sign the user in, then call " +
        "data_catalog again.",
      { status: "empty", tables: [] }
    );
  }

  // Grouped by where the data comes from, because the model has to pass the
  // right org_id back and a flat list makes that a guess.
  const groups = new Map();
  for (const t of items) {
    const key = String(t.org_id || t.source || "public");
    if (!groups.has(key)) groups.set(key, { org_id: key, source: t.source || "org", name: t.org_name || t.organization || null, rows: [] });
    groups.get(key).rows.push(t);
  }

  const lines = [];
  for (const g of groups.values()) {
    const label = g.source === "public" ? "Public data" : g.name || g.org_id;
    lines.push(`${label} — org_id "${g.org_id}", ${g.rows.length} table${g.rows.length === 1 ? "" : "s"}`);
    for (const t of g.rows) {
      const bits = [];
      if (t.rows !== undefined && t.rows !== null) bits.push(`${num(t.rows)} rows`);
      if (Array.isArray(t.columns)) bits.push(`${t.columns.length} columns`);
      lines.push(`  • ${t.id}${t.title && t.title !== t.id ? ` — ${t.title}` : ""}${bits.length ? ` · ${bits.join(" · ")}` : ""}`);
    }
  }

  return {
    content: [
      {
        type: "text",
        text:
          lines.join("\n") +
          "\n\nPick the table that answers the question, call data_schema on it to get " +
          "its real column names, then call data_query with the narrowest SQL that " +
          "answers it.",
      },
    ],
    structuredContent: { status: "ok", table_count: items.length, tables: fitRows(items) },
  };
}

/** Columns as a list, whether the profile is a list or a name-keyed object. */
function schemaColumns(json) {
  const c = json && json.columns;
  if (Array.isArray(c)) return c.map((x) => (x && typeof x === "object" ? x : { name: String(x) }));
  if (c && typeof c === "object") {
    return Object.entries(c).map(([name, v]) => ({ name, ...(v && typeof v === "object" ? v : { dtype: v }) }));
  }
  return [];
}

function columnDetail(c) {
  const bits = [];
  const note = c.note || c.description || c.comment;
  if (note) bits.push(String(note));
  const samples = c.sample_values || c.samples || c.values || c.unique_values;
  if (Array.isArray(samples) && samples.length) bits.push(`e.g. ${samples.slice(0, 6).map(cell).join(", ")}`);
  if (c.min !== undefined && c.min !== null && c.max !== undefined && c.max !== null) {
    bits.push(`${cell(c.min)} … ${cell(c.max)}`);
  }
  if (c.median !== undefined && c.median !== null) bits.push(`median ${cell(c.median)}`);
  else if (c.mean !== undefined && c.mean !== null) bits.push(`mean ${cell(c.mean)}`);
  return bits.join(" · ");
}

function schemaResult(json, orgId, tableId) {
  const cols = schemaColumns(json);
  const header = [`${tableId} (org_id "${orgId}")`];
  const desc = json.description || json.title;
  if (desc && desc !== tableId) header.push(String(desc));
  const rowCount = json.rows ?? json.row_count;
  if (rowCount !== undefined && rowCount !== null) header.push(`${num(rowCount)} rows`);
  const refreshed = json.refreshedAt || json.refreshed_at;
  if (refreshed) header.push(`last refreshed ${refreshed}`);

  const body = cols.length
    ? markdownTable(
        ["column", "type", "nulls", "notes"],
        cols.map((c) => [c.name, c.dtype || c.type || "", c.nulls ?? c.null_count ?? "", columnDetail(c)])
      )
    : "(this table reported no column profile)";

  return {
    content: [
      {
        type: "text",
        text:
          header.join(" · ") +
          "\n\n" +
          body +
          "\n\nUse these exact column names in data_query, and select only the ones the " +
          "question needs." +
          (refreshed ? ` Cite the table and its refresh date (${refreshed}) when you answer.` : ""),
      },
    ],
    structuredContent: { status: "ok", org_id: orgId, table_id: tableId, schema: json },
  };
}

function queryResult(json, meta) {
  // A large result spills to a parquet file and comes back as a preview; a
  // small one is the whole thing. Both shapes render the same way.
  const payload = json && json.preview && (json.preview.columns || json.preview.rows) ? json.preview : json || {};
  const rawRows = Array.isArray(payload.rows) ? payload.rows : [];
  const columns = normaliseColumns(payload, rawRows);
  const rows = normaliseRows(rawRows, columns);
  const total = Number.isFinite(json.row_count) ? json.row_count : Number.isFinite(payload.row_count) ? payload.row_count : rows.length;
  const shown = rows.slice(0, TEXT_ROWS);
  const truncated = !!(payload.truncated || json.truncated);
  const path = json.path || json.output_path || json.file || null;
  const used = payload.tables_used || json.tables_used;
  const elapsed = payload.elapsed_ms ?? json.elapsed_ms;

  const lines = [markdownTable(columns, shown)];
  lines.push(
    total > shown.length
      ? `\n${shown.length} of ${num(total)} rows shown.`
      : `\n${num(total)} row${total === 1 ? "" : "s"}.`
  );
  if (truncated) lines.push("The source capped this result — narrow the query if the missing rows matter.");
  if (path) lines.push(`The full result was written to ${path}.`);
  if (Array.isArray(used) && used.length) {
    lines.push(`From ${used.join(", ")} — name the table when you give the answer.`);
  }

  const fitted = fitRows(rows);
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: {
      status: "ok",
      org_id: meta.org_id,
      sql: meta.sql,
      columns,
      rows: fitted,
      rows_included: fitted.length,
      rows_returned: rows.length,
      row_count: total,
      truncated,
      tables_used: Array.isArray(used) ? used : [],
      elapsed_ms: elapsed ?? null,
      path,
    },
  };
}

function pullResult(json, meta) {
  const path = json.path || json.file || json.saved_to || json.output_path || null;
  const rowCount = json.row_count ?? json.rows ?? null;
  const where = meta.script_name ? `${meta.script_name}'s raw_pulls/` : "input_folder/";
  if (!path) {
    return say(
      `Pulled ${meta.table_id} from ${meta.org_id}, but the backend did not report where it landed. ` +
        `Check ${where} in the pane.`,
      { status: "ok", ...json, org_id: meta.org_id, table_id: meta.table_id }
    );
  }
  return say(
    `Saved ${rowCount !== null ? `${num(rowCount)} rows` : meta.table_id} to ${path}. ` +
      (meta.script_name
        ? `It belongs to the ${meta.script_name} script — its steps read it from raw_pulls/ and write ` +
          "the answer into final_output/."
        : "Scripts read it from input_folder/ — never modify it there, write results to output_folder/. " +
          "If the user only wanted an answer rather than a file, use data_query instead."),
    {
      status: "ok",
      org_id: meta.org_id,
      table_id: meta.table_id,
      path,
      row_count: rowCount,
      ...(meta.script_name ? { script_name: meta.script_name } : {}),
    }
  );
}

/** The rulebook, verbatim: it is markdown written for a model, so shaping it
 * would only damage it. `source` says whose rules these are — the project's own
 * AGENTS.md beats ours, and that distinction is worth stating. */
function rulesResult(json) {
  const md = String((json && json.markdown) || "").trim();
  if (!md) {
    return say(
      "VibeFoundry returned no rules for this project. Follow the project's AGENTS.md if it has one.",
      { status: "empty" }
    );
  }
  const source =
    json.source === "project"
      ? "This project's own AGENTS.md."
      : json.source === "remote"
        ? "VibeFoundry's current rulebook."
        : "VibeFoundry's built-in rules (the full rulebook could not be reached).";
  return {
    content: [{ type: "text", text: `${source}\n\n${md}` }],
    structuredContent: { status: "ok", source: json.source || null, bytes: json.bytes ?? md.length, markdown: md },
  };
}

module.exports = {
  MIN_BACKEND_VERSION,
  UPGRADE_TEXT,
  DATA_TOOL_NAMES,
  RULES_TOOL_NAME,
  REAUTH_TIMEOUT_MS,
  REAUTH_POLL_MS,
  reauthPendingText,
  orgConnected,
  dataTools,
  versionAtLeast,
  catalogResult,
  schemaResult,
  queryResult,
  pullResult,
  rulesResult,
};
