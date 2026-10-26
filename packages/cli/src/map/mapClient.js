/**
 * The browser side of the map. It reads the data the page has inline and
 * builds the faceted list, the inspector, the jump-to search and the
 * hover cards. It fetches nothing.
 */
(() => {
  const D = JSON.parse(document.getElementById("data").textContent);
  const S = D.s;
  const $ = (sel, root) => (root || document).querySelector(sel);
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---------- small helpers ----------

  const esc = (s) =>
    String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  const n = (x) => Number(x).toLocaleString("en-US");
  const plural = (count, one, many) =>
    `${n(count)} ${count === 1 ? one : many}`;
  const icon = (name, cls) =>
    D.icons[name].replace('class="ic"', `class="ic ${cls}"`);
  const str = (i) => (i === null || i === undefined ? null : S[i]);
  const short = (path) => {
    const parts = path.split("/");
    return parts.length > 3 ? `…/${parts.slice(-2).join("/")}` : path;
  };

  const unit = (i) => {
    const u = D.u[i];
    return {
      i,
      name: S[u[0]],
      file: S[u[1]],
      line: u[2],
      kind: S[u[3]],
      read: u[4],
      spec: u[5] === 1,
      id: S[u[6]],
      repo: u[7] === null ? null : S[D.repos[u[7]][0]],
      github: u[7] === null ? null : D.repos[u[7]][1],
      doc: u[8] === null || u[8] === undefined ? null : S[u[8]],
      boot: u[9] === 1,
    };
  };

  // With summaries from more than one repository, a unit says which one it
  // is in; with one, nothing changes.
  const repoNames = [...new Set(D.repos.map((r) => S[r[0]]))];
  const manyRepos = repoNames.length > 1;
  const inRepo = (u) =>
    manyRepos && u.repo ? `<span class="badge">${esc(u.repo)}</span> ` : "";
  const boundary = (i) => {
    const b = D.b[i];
    return { i, label: S[b[0]], cat: b[1], name: S[b[2]], system: str(b[3]) };
  };

  // ---------- links into the editor ----------

  let scheme = "vscode";
  try {
    scheme = localStorage.getItem("suss-map-editor") || "vscode";
  } catch (_err) {
    scheme = "vscode";
  }

  const HREF = {
    vscode: (path, line) => `vscode://file${encodeURI(path)}:${line}`,
    cursor: (path, line) => `cursor://file${encodeURI(path)}:${line}`,
    file: (path) => `file://${encodeURI(path)}`,
  };

  /** The file on disk in the chosen editor when the page knows where it is, or else on GitHub at the commit read. */
  /** A spec's unit links to the spec file, at the line it was declared on when the reader records one. */
  function hrefOf(u, line) {
    const file = u.spec ? u.doc : u.file;
    if (file === null) {
      return null;
    }
    const at = line > 0 ? line : 1;
    const root = D.roots[u.read];
    const github = u.github ? `${u.github}${encodeURI(file)}#L${at}` : null;
    if (root === null || root === undefined || scheme === "github") {
      return github;
    }
    return (HREF[scheme] || HREF.vscode)(`${root}/${file}`, at);
  }

  /** A link to a line; without one, a link to the function, marked as such. */
  function loc(ui, line, label) {
    const u = unit(ui);
    const exact = line !== null && line !== undefined;
    const shown =
      label || (exact ? `${short(u.file)}:${line}` : `in ${u.name}`);
    const href = hrefOf(u, exact ? line : u.line);
    const cls = exact ? "loc" : "loc loc-fn";
    const term = exact ? "" : ' data-term="fnline"';
    if (href === null) {
      return `<span class="${cls}"${term}>${esc(shown)}</span>`;
    }
    return `<a class="${cls}"${term} href="${esc(href)}" data-u="${ui}" data-l="${exact ? line : u.line}">${esc(shown)}</a>`;
  }

  function relink(root) {
    root.querySelectorAll("a[data-u]").forEach((a) => {
      const href = hrefOf(unit(Number(a.dataset.u)), Number(a.dataset.l));
      if (href !== null) {
        a.setAttribute("href", href);
      }
    });
  }

  // ---------- badges and references ----------

  const code = (text) =>
    `<code class="src">${esc(String(text).replace(/\s+/g, " "))}</code>`;
  const statusPill = (s) =>
    s === null || s === undefined
      ? `<span class="status s-unknown" data-status="?">?</span>`
      : `<span class="status s-${Math.floor(s / 100)}xx" data-status="${s}">${s}</span>`;
  const GQL_BADGE = {
    Query: "m-get",
    Subscription: "m-get",
    Mutation: "m-mutation",
  };
  const typeBadge = (name) =>
    `<span class="method ${GQL_BADGE[name] || "m-type"}">${esc(name)}</span>`;
  const badge = (e) =>
    e.k === "q"
      ? typeBadge(S[e.m])
      : `<span class="method m-${esc(S[e.m].toLowerCase())}">${esc(S[e.m])}</span>`;
  const entryRef = (i) =>
    `<button type="button" class="ref ref-route" data-open="entry-${i}" data-peek="entry-${i}">${badge(D.e[i])}<span class="path">${esc(S[D.e[i].p])}</span></button>`;
  const tableRef = (b) =>
    `<button type="button" class="ref ref-table" data-open="table-${b}" data-peek="table-${b}">${icon("table", "i-table")}<span class="path">${esc(boundary(b).name)}</span></button>`;
  const envRef = (b) =>
    `<button type="button" class="ref ref-table" data-open="env-${b}">${icon("env", "i-env")}<span class="path">${esc(boundary(b).name)}</span></button>`;
  const verb = (k) =>
    k === "w"
      ? `<span class="verb verb-write" data-term="writes">${icon("write", "i-write")}writes</span>`
      : `<span class="verb verb-read" data-term="reads">${icon("read", "i-read")}reads</span>`;
  const askLine = (question) =>
    `<div class="ask-line"><span>The same from the command line:</span><code>suss ask "${esc(question)}" --dir ${esc(D.askDir)}</code></div>`;

  // A pack can describe a condition in words ("request input fails
  // validation"); that reads as text, and anything else as code.
  const isWords = (text) =>
    /^[a-z][a-z ]+$/i.test(text) && text.split(" ").length >= 4;
  const condText = (text) => (isWords(text) ? esc(text) : code(text));

  function conditionHtml(list) {
    if (!list || list.length === 0) {
      return "";
    }
    const last = S[list[list.length - 1]];
    const more =
      list.length > 1
        ? `<button type="button" class="cond-more" data-toggle-conds aria-expanded="false">+${list.length - 1} earlier</button><ol class="cond-all" hidden>${list.map((c) => `<li>${condText(S[c])}</li>`).join("")}</ol>`
        : "";
    return `<span class="cond">when ${condText(last)}${more}</span>`;
  }

  // ---------- facts derived for the list ----------

  const opOfUnit = new Map(D.ops.map((op, i) => [op[0], i]));

  /** Routes group by file, fields by type, and both by repository first when there are several. */
  function groupOf(e, first) {
    const own = e.k === "q" ? S[e.m] : first ? first.file : "";
    return manyRepos && first?.repo ? `${first.repo} · ${own}` : own;
  }

  const entries = D.e.map((e, i) => {
    const groups = {
      writes: new Map(),
      reads: new Map(),
      env: new Map(),
      other: new Map(),
    };
    for (const item of e.r) {
      const b = boundary(item[0]);
      const rel = item[1];
      const add = (bucket) => {
        const list = bucket.get(item[0]) || [];
        list.push(item);
        bucket.set(item[0], list);
      };
      if (b.cat === "t" && rel.includes("w")) {
        add(groups.writes);
      }
      if (b.cat === "t" && rel.includes("r")) {
        add(groups.reads);
      }
      if (b.cat === "e") {
        add(groups.env);
      }
      if (b.cat === "o") {
        add(groups.other);
      }
    }
    const statuses = [...new Set(e.o.map((o) => o[0]))].sort(
      (a, b) => (a === null ? 999 : a) - (b === null ? 999 : b),
    );
    const first = e.u.length
      ? unit(e.u[0])
      : e.sp.length
        ? unit(e.sp[0])
        : null;
    return {
      i,
      gql: e.k === "q",
      writes: groups.writes,
      reads: groups.reads,
      env: groups.env,
      other: groups.other,
      statuses,
      early: [
        ...new Set(
          e.o
            .filter((o) => o[6] !== null && o[0] !== null && o[0] >= 300)
            .map((o) => S[o[6]]),
        ),
      ],
      group: groupOf(e, first),
      unit: first,
      text: `${S[e.m]} ${S[e.p]} ${S[e.m]}.${S[e.p]} ${first ? `${first.name} ${first.file}` : ""}`.toLowerCase(),
    };
  });

  const tables = D.t.map((t) => {
    const b = t[0];
    return {
      b,
      name: boundary(b).name,
      system: boundary(b).system || "",
      writers: entries.filter((e) => e.writes.has(b)),
      readers: entries.filter((e) => e.reads.has(b)),
      writePlaces: t[1],
      readPlaces: t[2],
      text: `${boundary(b).name} ${boundary(b).system || ""}`.toLowerCase(),
    };
  });
  const tableOf = new Map(tables.map((t, i) => [t.b, i]));

  const envByBoundary = new Map();
  for (const read of D.env) {
    const list = envByBoundary.get(read[0]) || [];
    list.push(read);
    envByBoundary.set(read[0], list);
  }
  const envs = [...envByBoundary.entries()]
    .map(([b, reads]) => ({
      b,
      name: boundary(b).name,
      reads,
      defaults: reads.filter((r) => r[2] === 1).length,
      // Read by a config file the app renders when it boots, such as Rails' database.yml.
      boot: reads.some((r) => unit(r[1]).boot),
      entries: entries.filter((e) => e.env.has(b)),
      text: `${boundary(b).name} ${reads.map((r) => unit(r[1]).file).join(" ")}`.toLowerCase(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const envOf = new Map(envs.map((e, i) => [e.b, i]));

  const types = D.ty.map((t, i) => ({
    i,
    name: S[t[0]],
    fields: t[1],
    kind: t[2] || "object",
    members: (t[3] || []).map((m) => S[m]),
    resolvers: t[1].filter((f) => f[4] !== null).length,
    text: `${S[t[0]]} ${t[1].map((f) => S[f[0]]).join(" ")} ${(t[3] || []).map((m) => S[m]).join(" ")}`.toLowerCase(),
  }));

  /** What the type list and the drawer say a type has: its fields, or an enum's values, a union's members, or that it is a scalar. */
  const TYPE_CONTENTS = {
    object: (t) => plural(t.fields.length, "field", "fields"),
    enum: (t) => plural(t.members.length, "value", "values"),
    union: (t) => plural(t.members.length, "member", "members"),
    scalar: () => "scalar",
  };
  const typeOf = new Map(types.map((t) => [t.name, t.i]));

  const pages = D.pg.map((p, i) => {
    const u = unit(p[0]);
    return {
      i,
      unit: u,
      ui: p[0],
      path: S[p[1]],
      text: `${u.name} ${S[p[1]]} ${u.file}`.toLowerCase(),
    };
  });

  /** A type as the page prints it, with each name the run knows as a link to that type. */
  function typeHtml(text) {
    return esc(text).replace(/[A-Za-z_][\w]*/g, (word) =>
      typeOf.has(word)
        ? `<button type="button" class="type-ref" data-open="type-${typeOf.get(word)}">${word}</button>`
        : word,
    );
  }

  function signature(name, args, returns) {
    const list = args.map(
      (a) => `${esc(S[a[0]])}: ${typeHtml(S[a[1]])}${a[2] === 1 ? "!" : ""}`,
    );
    return `${esc(name)}${list.length ? `(${list.join(", ")})` : ""}: ${typeHtml(S[returns])}`;
  }

  // ---------- facets ----------

  const STATUS_BANDS = {
    "2xx": "Success",
    "3xx": "Redirect",
    "4xx": "Client error",
    "5xx": "Server error",
    "?": "Unknown",
  };
  const band = (s) => (s === null ? "?" : `${Math.floor(s / 100)}xx`);
  const dbValue = (e) =>
    e.writes.size ? "writes" : e.reads.size ? "reads" : "none";
  const callerValue = (e) => {
    const raw = D.e[e.i];
    if (raw.f.length) {
      return ["has", "finding"];
    }
    return raw.c.length ? ["has"] : ["none"];
  };

  const CALLER_FACET = {
    id: "caller",
    title: "Caller here",
    values: callerValue,
    labels: {
      has: "Has a caller",
      finding: "Has a finding",
      none: "No caller",
    },
    icons: { finding: ["clash", "i-clash"], has: ["check", "i-check"] },
  };
  const DB_FACET = {
    id: "db",
    title: "Tables",
    values: (e) => [dbValue(e)],
    labels: { writes: "Writes", reads: "Only reads", none: "None reached" },
    icons: { writes: ["write", "i-write"], reads: ["read", "i-read"] },
  };
  const PARTIAL_FACET = {
    id: "partial",
    title: "Calls not followed",
    values: (e) => [D.e[e.i].gn > 0 ? "yes" : "no"],
    labels: { yes: "On the way", no: "None" },
    icons: { yes: ["partial", "i-partial"] },
  };
  const READ_FACET = {
    id: "read",
    title: "Read by suss",
    when: () => D.e.some((e) => e.nr === 1),
    values: (e) => [D.e[e.i].nr === 1 ? "no" : "yes"],
    labels: { yes: "Read", no: "Not read" },
    icons: { no: ["partial", "i-partial"] },
  };
  const SPEC_FACET = {
    id: "spec",
    title: "Spec",
    when: () => D.e.some((e) => e.sp.length > 0),
    values: (e) => {
      const raw = D.e[e.i];
      if (!raw.u.length) {
        return ["only"];
      }
      return [raw.sp.length ? "yes" : "no"];
    },
    labels: {
      yes: "In a spec",
      no: "Not in a spec",
      only: "Spec only, no code",
    },
  };

  const REPO_FACET = {
    id: "repo",
    title: "Repository",
    when: () => manyRepos,
    values: (e) => [e.unit?.repo || "spec"],
  };

  const FACETS = {
    routes: [
      REPO_FACET,
      {
        id: "method",
        title: "Method",
        values: (e) => [S[D.e[e.i].m]],
        order: ["GET", "POST", "PUT", "PATCH", "DELETE"],
      },
      DB_FACET,
      {
        id: "status",
        title: "Returns",
        values: (e) => [
          ...new Set(e.statuses.map(band)),
          ...(e.statuses.some((s) => s !== null && s >= 400) ? ["error"] : []),
        ],
        labels: Object.assign({ error: "Any error" }, STATUS_BANDS),
        hidden: ["error"],
        order: ["2xx", "3xx", "4xx", "5xx", "?", "error"],
      },
      CALLER_FACET,
      PARTIAL_FACET,
      READ_FACET,
      {
        id: "early",
        title: "Early return from",
        values: (e) => e.early,
        limit: 6,
        icons: { "*": ["guard", "i-guard"] },
      },
      SPEC_FACET,
      {
        id: "group",
        title: "File",
        values: (e) => [e.group],
        labelOf: (v) => short(v),
        limit: 8,
      },
    ],
    graphql: [
      REPO_FACET,
      {
        id: "type",
        title: "Type",
        values: (e) => [S[D.e[e.i].m]],
        order: ["Query", "Mutation", "Subscription"],
      },
      CALLER_FACET,
      READ_FACET,
      DB_FACET,
      PARTIAL_FACET,
      SPEC_FACET,
    ],
    types: [
      {
        id: "code",
        title: "Resolvers in code",
        values: (t) => [
          t.resolvers === 0
            ? "none"
            : t.resolvers === t.fields.length
              ? "all"
              : "some",
        ],
        labels: { all: "Every field", some: "Some fields", none: "None" },
      },
    ],
    pages: [],
    tables: [
      {
        id: "written",
        title: "Written by a route",
        values: (t) => [t.writers.length ? "yes" : "no"],
        labels: { yes: "Yes", no: "No" },
        icons: { yes: ["write", "i-write"] },
      },
      {
        id: "read",
        title: "Read by a route",
        values: (t) => [t.readers.length ? "yes" : "no"],
        labels: { yes: "Yes", no: "No" },
        icons: { yes: ["read", "i-read"] },
      },
      { id: "system", title: "System", values: (t) => [t.system || "unknown"] },
    ],
    env: [
      {
        id: "default",
        title: "Default",
        values: (e) => [
          e.defaults === e.reads.length
            ? "yes"
            : e.defaults === 0
              ? "no"
              : "some",
        ],
        labels: { yes: "At every read", no: "None", some: "At some reads" },
      },
    ],
  };

  const ITEMS = {
    routes: entries.filter((e) => !e.gql),
    graphql: entries.filter((e) => e.gql),
    types,
    pages,
    tables,
    env: envs,
  };
  const NOUNS = {
    routes: ["route", "routes"],
    graphql: ["field", "fields"],
    types: ["type", "types"],
    pages: ["page", "pages"],
    tables: ["table", "tables"],
    env: ["variable", "variables"],
  };
  const firstTab = $('[role="tab"][aria-selected="true"]');
  const state = {
    tab: firstTab ? firstTab.dataset.tab : "routes",
    facets: {
      routes: {},
      graphql: {},
      types: {},
      pages: {},
      tables: {},
      env: {},
    },
    text: {
      routes: "",
      graphql: "",
      types: "",
      pages: "",
      tables: "",
      env: "",
    },
    more: {},
    shown: {},
  };

  const activeFacets = (tab) => FACETS[tab].filter((f) => !f.when || f.when());

  function matches(tab, item, skip) {
    for (const f of activeFacets(tab)) {
      const want = state.facets[tab][f.id];
      if (want === undefined || f.id === skip) {
        continue;
      }
      if (!f.values(item).includes(want)) {
        return false;
      }
    }
    const text = state.text[tab].trim().toLowerCase();
    return !text || text.split(/\s+/).every((t) => item.text.includes(t));
  }

  const labelFor = (f, v) => (f.labelOf ? f.labelOf(v) : f.labels?.[v] || v);
  const iconFor = (f, v) => {
    if (f.id === "status") {
      return v === "error"
        ? `<span class="status s-4xx">4xx</span>`
        : `<span class="status s-${v === "?" ? "unknown" : v}">${esc(v)}</span>`;
    }
    const spec = f.icons && (f.icons[v] || f.icons["*"]);
    return spec ? icon(spec[0], spec[1]) : "";
  };

  function renderFacets() {
    const tab = state.tab;
    const html = activeFacets(tab)
      .map((f) => {
        const counts = new Map();
        for (const item of ITEMS[tab]) {
          if (!matches(tab, item, f.id)) {
            continue;
          }
          for (const v of f.values(item)) {
            counts.set(v, (counts.get(v) || 0) + 1);
          }
        }
        const selected = state.facets[tab][f.id];
        const values = [...counts.keys()].filter(
          (v) => !(f.hidden || []).includes(v) || v === selected,
        );
        values.sort(
          (a, b) =>
            (f.order ? f.order.indexOf(a) - f.order.indexOf(b) : 0) ||
            (counts.get(b) || 0) - (counts.get(a) || 0),
        );
        if (values.length === 0 && selected === undefined) {
          return "";
        }
        const key = `${tab}:${f.id}`;
        const limit =
          f.limit && !state.more[key] ? f.limit : Number.POSITIVE_INFINITY;
        const shown = values.slice(0, limit);
        if (selected !== undefined && !shown.includes(selected)) {
          shown.push(selected);
        }
        const opts = shown
          .map(
            (v) =>
              `<button type="button" class="facet-opt" data-facet-id="${esc(f.id)}" data-facet-value="${esc(v)}" aria-pressed="${selected === v}">${iconFor(f, v)}<span class="lbl" title="${esc(labelFor(f, v))}">${esc(labelFor(f, v))}</span><span class="n">${n(counts.get(v) || 0)}</span></button>`,
          )
          .join("");
        const more =
          values.length > shown.length
            ? `<button type="button" class="facet-more" data-facet-more="${esc(key)}">Show ${values.length - shown.length} more</button>`
            : "";
        return `<div class="facet"><h3>${esc(f.title)}</h3>${opts}${more}</div>`;
      })
      .join("");
    $("#facets").innerHTML = html;
    $("#facets-wrap").hidden = html === "";

    const tokens = activeFacets(tab)
      .filter((f) => state.facets[tab][f.id] !== undefined)
      .map(
        (f) =>
          `<button type="button" class="token" data-facet-id="${esc(f.id)}" data-facet-value="${esc(state.facets[tab][f.id])}" aria-label="Remove filter ${esc(f.title)}: ${esc(labelFor(f, state.facets[tab][f.id]))}">${esc(f.title)}: <b>${esc(labelFor(f, state.facets[tab][f.id]))}</b>${icon("close", "i-go")}</button>`,
      );
    $("#tokens").innerHTML = tokens.length
      ? `${tokens.join("")}<button type="button" class="token-clear" data-clear>Clear all</button>`
      : "";
  }

  // ---------- list rows ----------

  const numCell = (size, kind) =>
    size
      ? `<span class="badge${kind === "w" ? " badge-write" : ""}" data-term="${kind === "w" ? "writes" : "reads"}">${icon(kind === "w" ? "write" : "read", kind === "w" ? "i-write" : "i-read")}${size}</span>`
      : `<span class="badge none">·</span>`;

  // A flag every row has says nothing about any one of them, so a row
  // shows it only when some rows do not.
  const everyRowUnfollowed = D.e.every((e) => e.gn > 0);

  function flagsOf(e) {
    const raw = D.e[e.i];
    const flags = [];
    if (raw.f.length) {
      flags.push(
        `<span class="badge badge-clash" data-term="finding">${icon("clash", "i-clash")}finding</span>`,
      );
    }
    if (raw.nr === 1) {
      flags.push(
        `<span class="badge badge-partial" data-term="unread">${icon("partial", "i-partial")}not read</span>`,
      );
    } else if (raw.gn > 0 && !everyRowUnfollowed) {
      flags.push(
        `<span class="badge badge-partial" data-term="partial">${icon("partial", "i-partial")}calls not followed</span>`,
      );
    }
    if (!raw.u.length) {
      flags.push(`<span class="badge" data-term="speconly">spec only</span>`);
    }
    return flags.join("");
  }

  function routeItem(e) {
    const raw = D.e[e.i];
    return `<button type="button" class="item route-item" data-open="entry-${e.i}" data-peek="entry-${e.i}">
      <span class="item-main">${badge(raw)}<span class="item-path">${esc(S[raw.p])}</span></span>
      <span class="cells"><span class="statuses">${e.statuses.map(statusPill).join("")}</span><span class="c-num">${numCell(e.writes.size, "w")}</span><span class="c-num">${numCell(e.reads.size, "r")}</span><span class="c-flag">${flagsOf(e)}</span></span>
    </button>`;
  }

  function fieldItem(e) {
    const raw = D.e[e.i];
    const returns = raw.sh ? S[raw.sh[1]] : "";
    const callers = raw.c.length
      ? `<span class="badge" data-term="ops">${n(raw.c.length)}</span>`
      : `<span class="badge none">·</span>`;
    return `<button type="button" class="item field-item" data-open="entry-${e.i}" data-peek="entry-${e.i}">
      <span class="item-main"><span class="item-path">${esc(S[raw.p])}</span></span>
      <span class="cells"><span class="c-type">${esc(returns)}</span><span class="c-num">${callers}</span><span class="c-num">${numCell(e.writes.size, "w")}</span><span class="c-num">${numCell(e.reads.size, "r")}</span><span class="c-flag">${flagsOf(e)}</span></span>
    </button>`;
  }

  /** At most this many rows per list at first; a button shows the rest. */
  const PAGE_ROWS = 300;

  function capped(tab, rows) {
    const limit = state.shown[tab] || PAGE_ROWS;
    if (rows.length <= limit) {
      return rows.join("");
    }
    return `${rows.slice(0, limit).join("")}<button type="button" class="more-rows" data-more-rows>Show ${n(Math.min(PAGE_ROWS, rows.length - limit))} more of ${n(rows.length - limit)}</button>`;
  }

  function grouped(tab, shown, head, item, groupHead) {
    const order = [...new Set(shown.map((x) => x.group))];
    const rows = [];
    for (const g of order) {
      const inGroup = shown.filter((x) => x.group === g);
      rows.push(groupHead(g, inGroup));
      for (const x of inGroup) {
        rows.push(item(x));
      }
    }
    return head + capped(tab, rows);
  }

  const GQL_RANK = { Query: 0, Mutation: 1, Subscription: 2 };

  const LIST_RENDERERS = {
    routes: (shown) =>
      grouped(
        "routes",
        shown,
        `<div class="list-head route-cols" aria-hidden="true"><span>Route</span><span>Returns</span><span>Writes</span><span>Reads</span><span></span></div>`,
        routeItem,
        (g, inGroup) =>
          `<div class="group-head"><span class="group-name">${esc(g || "Declared in a spec")}</span><span class="group-count">${plural(inGroup.length, "route", "routes")}</span></div>`,
      ),
    graphql: (shown) =>
      grouped(
        "graphql",
        shown
          .slice()
          .sort((a, b) => (GQL_RANK[a.group] ?? 9) - (GQL_RANK[b.group] ?? 9)),
        `<div class="list-head field-cols" aria-hidden="true"><span>Field</span><span>Type</span><span>Callers</span><span>Writes</span><span>Reads</span><span></span></div>`,
        fieldItem,
        (g, inGroup) =>
          `<div class="group-head">${typeBadge(g)}<span class="group-count">${plural(inGroup.length, "field", "fields")}</span></div>`,
      ),
    types: (shown) =>
      `<div class="list-head type-cols" aria-hidden="true"><span>Type</span><span>Fields</span><span>In code</span></div>${capped(
        "types",
        shown.map(
          (t) =>
            `<button type="button" class="item type-item" data-open="type-${t.i}"><span class="item-main">${icon("type", "i-go")}<span class="item-path">${esc(t.name)}</span></span><span class="cells"><span class="c-num"><span class="badge">${t.kind === "object" ? n(t.fields.length) : TYPE_CONTENTS[t.kind](t)}</span></span><span class="c-num"><span class="badge">${t.resolvers ? plural(t.resolvers, "resolver", "resolvers") : "schema only"}</span></span></span></button>`,
        ),
      )}`,
    pages: (shown) =>
      capped(
        "pages",
        shown.map(
          (p) =>
            `<button type="button" class="item" data-open="page-${p.i}"><span class="item-main">${icon("route", "i-go")}<span class="item-path">${esc(p.path)}</span><span class="system">${esc(p.unit.name)}</span></span><span class="item-side"><span class="badge">${esc(short(p.unit.file))}</span></span></button>`,
        ),
      ),
    tables: (shown) => {
      const max = Math.max(
        1,
        ...tables.map((t) => Math.max(t.writers.length, t.readers.length)),
      );
      return capped(
        "tables",
        shown
          .slice()
          .sort(
            (a, b) =>
              b.writers.length - a.writers.length ||
              b.readers.length - a.readers.length,
          )
          .map(
            (
              t,
            ) => `<button type="button" class="item table-item" data-open="table-${t.b}" data-peek="table-${t.b}">
          <span class="item-main">${icon("table", "i-table")}<span class="item-path">${esc(t.name)}</span><span class="system">${esc(t.system)}</span></span>
          <span class="bars">
            ${icon("write", "i-write")}<span>written by</span><span class="bar-track"><span class="bar-fill w" style="width:${(100 * t.writers.length) / max}%"></span></span><span class="n">${plural(t.writers.length, "route", "routes")}</span>
            ${icon("read", "i-read")}<span>read by</span><span class="bar-track"><span class="bar-fill" style="width:${(100 * t.readers.length) / max}%"></span></span><span class="n">${plural(t.readers.length, "route", "routes")}</span>
          </span>
        </button>`,
          ),
      );
    },
    env: (shown) => {
      const head = `<div class="list-head env-cols" aria-hidden="true"><span>Variable</span><span>Read in</span><span>Default</span></div>`;
      const boot = shown.filter((e) => e.boot);
      const inCode = shown.filter((e) => !e.boot);
      if (boot.length === 0) {
        return head + capped("env", inCode.map(envItem));
      }
      const group = (name, list) =>
        `<div class="group-head"><span class="group-name group-label">${name}</span><span class="group-count">${plural(list.length, "variable", "variables")}</span></div>`;
      return `${head}${group("Read when the app boots", boot)}${boot.map(envItem).join("")}${inCode.length ? group("Read in code", inCode) + capped("env", inCode.map(envItem)) : ""}`;
    },
  };

  function envItem(e) {
    // A variable a boot config reads shows that file first.
    const first = unit(
      (e.boot ? e.reads.find((r) => unit(r[1]).boot) : e.reads[0])[1],
    );
    return `<button type="button" class="item env-item" data-open="env-${e.b}">
          <span class="item-main">${icon("env", "i-env")}<span class="item-path">${esc(e.name)}</span></span>
          <span class="cells"><span class="c-type">${esc(short(first.file))}${e.reads.length > 1 ? ` +${e.reads.length - 1}` : ""}</span><span class="c-type" data-term="default">${envDefaultCell(e)}</span></span>
        </button>`;
  }

  /** The value the code falls back to when the variable is unset, or how its reads differ. */
  function envDefaultCell(e) {
    if (e.defaults === 0) {
      return `<span class="muted">none</span>`;
    }
    const values = [
      ...new Set(
        e.reads
          .filter((r) => r[2] === 1 && r[3] !== null && r[3] !== undefined)
          .map((r) => S[r[3]]),
      ),
    ];
    const shown =
      values.length === 1
        ? esc(values[0])
        : `<span class="muted">${values.length > 1 ? `${values.length} values` : "yes"}</span>`;
    return e.defaults === e.reads.length
      ? shown
      : `${shown} <span class="muted">at ${e.defaults} of ${e.reads.length} reads</span>`;
  }

  const EMPTY_TEXT = {
    routes: "No routes found.",
    graphql: "No GraphQL fields found.",
    types: "No GraphQL types found.",
    pages: "No client-side pages found.",
    tables: "No tables found. A pack for your ORM finds them. See Coverage.",
    env: "No environment variable reads found.",
  };

  function renderList() {
    const tab = state.tab;
    document.querySelectorAll('.tabs [role="tab"]').forEach((el) => {
      el.setAttribute("aria-selected", String(el.dataset.tab === tab));
    });
    $("#panel").setAttribute("aria-labelledby", `tab-${tab}`);
    $("#filter").value = state.text[tab];
    renderFacets();
    const all = ITEMS[tab];
    const shown = all.filter((item) => matches(tab, item));
    const [one, many] = NOUNS[tab];
    $("#list-count").textContent =
      shown.length === all.length
        ? plural(all.length, one, many)
        : `${n(shown.length)} of ${plural(all.length, one, many)}`;
    if (all.length === 0) {
      $("#panel").innerHTML = `<p class="empty">${esc(EMPTY_TEXT[tab])}</p>`;
      return;
    }
    if (shown.length === 0) {
      $("#panel").innerHTML =
        `<div class="empty"><p class="empty">No ${many} match these filters.</p><button type="button" class="action" data-clear>Clear the filters</button></div>`;
      return;
    }
    $("#panel").innerHTML = LIST_RENDERERS[tab](shown);
  }

  // ---------- inspector ----------

  function section(title, count, body, opts) {
    if (!body) {
      return "";
    }
    const open = !opts?.closed;
    const from = opts?.from
      ? `<span class="from"><span class="from-tag" data-tip="${esc(opts.from[1])}">${esc(opts.from[0])}</span></span>`
      : "";
    return `<details class="d-section"${open ? " open" : ""}><summary>${icon("chevron", "i-chev")}${title}${count !== null && count !== undefined ? ` <span class="n">${n(count)}</span>` : ""}${from}</summary>${opts?.note ? `<p class="d-note">${opts.note}</p>` : ""}${body}</details>`;
  }

  function limited(items, limit) {
    if (items.length <= limit) {
      return `<ul class="d-list">${items.map((x) => `<li>${x}</li>`).join("")}</ul>`;
    }
    const head = items
      .slice(0, limit)
      .map((x) => `<li>${x}</li>`)
      .join("");
    const rest = items
      .slice(limit)
      .map((x) => `<li hidden data-rest>${x}</li>`)
      .join("");
    return `<ul class="d-list">${head}${rest}</ul><button type="button" class="action show-all" data-show-all>Show all ${n(items.length)}</button>`;
  }

  function through(hops) {
    if (!hops || hops.length === 0) {
      return "";
    }
    return `<span class="through" data-term="through">via ${hops.map((h) => `<span class="hop">${esc(S[h])}</span>`).join('<span class="arrow" aria-hidden="true">›</span>')}</span>`;
  }

  /** One reach item: the call, where it is, and the calls on the way. */
  function siteHtml(item) {
    const via =
      item[3] === null
        ? ""
        : `<div class="site-code">${code(S[item[3]])}</div>`;
    return `<div class="site">${via}<div class="site-meta">${loc(item[2], item[5])}${through(item[4])}</div></div>`;
  }

  function groupsOf(map, kind, refOf) {
    return [...map.entries()]
      .sort((a, b) => boundary(a[0]).name.localeCompare(boundary(b[0]).name))
      .map(([b, items]) => {
        const sorted = items.slice().sort((x, y) => x[4].length - y[4].length);
        const rest =
          sorted.length > 2
            ? `<p class="d-note">and ${plural(sorted.length - 2, "more place", "more places")}</p>`
            : "";
        return `<div class="table-head">${kind ? verb(kind) : ""}${refOf(b)}</div>${sorted
          .slice(0, 2)
          .map(siteHtml)
          .join("")}${rest}`;
      });
  }

  const stat = (value, label, cls) =>
    `<div class="d-stat ${cls || ""}"><b>${value}</b><span class="d-stat-l">${label}</span></div>`;

  function reachSections(e, ask) {
    const from = ["ask", ask];
    return [
      section(
        "Writes",
        e.writes.size,
        e.writes.size ? limited(groupsOf(e.writes, "w", tableRef), 8) : "",
        { from },
      ),
      section(
        "Reads",
        e.reads.size,
        e.reads.size ? limited(groupsOf(e.reads, "r", tableRef), 6) : "",
        { closed: e.reads.size > 6, from },
      ),
      section(
        "Env vars",
        e.env.size,
        e.env.size ? limited(groupsOf(e.env, null, envRef), 6) : "",
        { from },
      ),
      section(
        "Other boundaries",
        e.other.size,
        e.other.size
          ? limited(
              groupsOf(
                e.other,
                null,
                (b) =>
                  `<span class="unit-name">${esc(boundary(b).label)}</span>`,
              ),
              6,
            )
          : "",
        { closed: true, from },
      ),
    ].join("");
  }

  // ---------- findings, inflated the first time an inspector shows one ----------

  let findingRows = null;
  function loadFindingRows() {
    if (findingRows === null) {
      const text = $("#findings")?.textContent.trim() || "";
      findingRows =
        text === "" || typeof DecompressionStream === "undefined"
          ? Promise.resolve(null)
          : new Response(
              new Blob([Uint8Array.from(atob(text), (c) => c.charCodeAt(0))])
                .stream()
                .pipeThrough(new DecompressionStream("gzip")),
            )
              .json()
              .catch(() => null);
    }
    return findingRows;
  }

  function findingCallouts(raw, i) {
    if (!raw.f.length) {
      return "";
    }
    return `<div class="findings" data-findings="${i}"><p class="muted">Reading the findings…</p></div>`;
  }

  function findingCallout(f) {
    const sides = [
      f[3] !== null ? `served by ${loc(f[3], f[4])}` : "",
      f[5] !== null ? `called from ${loc(f[5], f[6])}` : "",
    ]
      .filter(Boolean)
      .join(", ");
    return `<div class="callout">${icon("clash", "i-clash")}<div><strong>${esc(f[0])}</strong> <span class="muted">${esc(f[1])}</span><br>${esc(f[2])}${sides ? `<div class="site-meta">${sides}</div>` : ""}</div></div>`;
  }

  /** Fills the findings of the entry the drawer shows, once their rows are inflated. */
  async function fillFindings() {
    const box = $("#drawer-body .findings");
    if (!box) {
      return;
    }
    const raw = D.e[Number(box.dataset.findings)];
    const rows = await loadFindingRows();
    if (!box.isConnected) {
      return;
    }
    if (rows === null) {
      box.innerHTML = `<p class="muted">This browser cannot inflate the findings. ${code(`suss check --dir ${D.askDir} --json`)} lists them.</p>`;
      return;
    }
    const more = raw.fx
      .map(
        (x) =>
          `<p class="muted">${plural(x[1], `more ${S[x[0]]} finding`, `more ${S[x[0]]} findings`)} here. ${code(`suss check --dir ${D.askDir} --json`)} lists them all.</p>`,
      )
      .join("");
    box.innerHTML = raw.f.map((fi) => findingCallout(rows[fi])).join("") + more;
  }

  /** One line per outcome: its status, when it happens and what it gives, then where. */
  function outcomeRows(raw) {
    const sorted = raw.o
      .slice()
      .sort(
        (a, b) => (a[0] === null ? 999 : a[0]) - (b[0] === null ? 999 : b[0]),
      );
    return sorted.map((o) => {
      const parts = [
        o[3].length
          ? conditionHtml(o[3])
          : `<span class="muted">${sorted.length === 1 ? "always" : "otherwise"}</span>`,
        // A GraphQL field's outcome gives the type it resolves to, in place
        // of a status it does not have.
        o[7] !== null && o[7] !== undefined
          ? `<span class="muted">returns</span> <span class="c-type">${typeHtml(S[o[7]])}</span>`
          : "",
        o[2] !== null
          ? `<span class="muted">raises</span> ${code(S[o[2]])}`
          : "",
        o[0] === null && S[o[1]] === "return" && raw.k !== "q"
          ? `<span class="muted">status set at runtime</span>`
          : "",
        o[6] !== null
          ? `<span class="badge" data-term="early">${icon("guard", "i-guard")}${esc(S[o[6]])}</span>`
          : "",
      ].filter(Boolean);
      return `<div class="outcome">${outcomePill(raw, o)}<span class="o-line">${parts.join('<span class="muted">, </span>')}</span><span class="o-at">${outcomePlace(o)}</span></div>`;
    });
  }

  /** Where an outcome happens, by file name and line, so the condition beside it keeps the width. */
  function outcomePlace(o) {
    if (o[5] === null || o[5] === undefined) {
      return loc(o[4], null);
    }
    const file = unit(o[4]).file;
    return loc(o[4], o[5], `${file.slice(file.lastIndexOf("/") + 1)}:${o[5]}`);
  }

  function outcomePill(raw, o) {
    if (o[0] !== null) {
      return statusPill(o[0]);
    }
    if (S[o[1]] === "throw") {
      return `<span class="status s-unknown">err</span>`;
    }
    return raw.k === "q" && S[o[1]] === "return"
      ? `<span class="status s-2xx">ok</span>`
      : `<span class="status s-unknown">?</span>`;
  }

  function gapSection(raw) {
    if (!raw.gn) {
      return "";
    }
    const rows = raw.g.map(
      (ui) =>
        `${loc(ui, null, unit(ui).name)} <span class="muted">${esc(short(unit(ui).file))}</span>`,
    );
    const more =
      raw.gn > raw.g.length
        ? `<p class="d-note">and ${n(raw.gn - raw.g.length)} more</p>`
        : "";
    return section(
      `${icon("partial", "i-partial")} Calls not followed`,
      raw.gn,
      `${limited(rows, 6)}${more}`,
      {
        note: "Calls suss couldn't follow. Lists above may be short.",
        closed: true,
        from: ["inspect", "suss inspect <file>"],
      },
    );
  }

  const OPERATION_TYPE = {
    query: "Query",
    mutation: "Mutation",
    subscription: "Subscription",
  };

  function callersSection(raw, isField) {
    if (!raw.c.length) {
      return section(
        isField ? "Operations" : "Callers",
        0,
        `<p class="empty-line">${icon("partial", "i-partial")}<span>No code in this repo calls it. Another client may.</span></p>`,
        { from: ["check", `suss check --dir ${D.askDir} --json`] },
      );
    }
    const rows = raw.c.map((ci) => {
      const op = opOfUnit.has(ci) ? D.ops[opOfUnit.get(ci)] : null;
      if (op) {
        const owner =
          op[3] !== null ? `<span>in ${esc(unit(op[3]).name)}</span>` : "";
        return `<div class="table-head">${inRepo(unit(op[0]))}${typeBadge(OPERATION_TYPE[S[op[1]]] || S[op[1]])}<span class="unit-name">${esc(S[op[2]])}</span></div><div class="site-meta">${loc(op[0], unit(op[0]).line, `${short(unit(op[0]).file)}:${unit(op[0]).line}`)}${owner}</div>`;
      }
      const u = unit(ci);
      return `${inRepo(u)}<span class="unit-name">${esc(u.name)}</span> ${loc(ci, u.line, `${short(u.file)}:${u.line}`)}`;
    });
    return section(
      isField ? "Operations" : "Callers",
      raw.c.length,
      limited(rows, 8),
      {
        from: ["check", `suss check --dir ${D.askDir} --json`],
      },
    );
  }

  /** Where a spec declares it, as a link to the file and line, or the reader's label when it gives no file. */
  function specPlace(ui) {
    const s = unit(ui);
    if (s.doc === null) {
      return code(s.file);
    }
    return loc(
      ui,
      s.line > 0 ? s.line : 1,
      s.line > 0 ? `${short(s.doc)}:${s.line}` : short(s.doc),
    );
  }

  /** Why no code serves an entry a spec declares. */
  function notServedReason(raw) {
    if (!D.u.some((u) => u[5] === 0)) {
      return "This run read only specs.";
    }
    return raw.k === "q"
      ? `No resolver in the code it read is bound to ${esc(S[raw.m])}.${esc(S[raw.p])}.`
      : `No handler in the code it read serves ${esc(S[raw.m])} ${esc(S[raw.p])}.`;
  }

  function specSection(raw, e) {
    if (!raw.sp.length || raw.k === "q") {
      return "";
    }
    const declared = raw.ss.map(statusPill).join("");
    const coded = e.statuses
      .filter((s) => s !== null)
      .map(statusPill)
      .join("");
    return section(
      "Spec",
      null,
      `<div class="shape"><span class="shape-l">The spec</span><span class="statuses">${declared || '<span class="muted">no statuses</span>'}</span></div>${raw.u.length ? `<div class="shape"><span class="shape-l">The code</span><span class="statuses">${coded || '<span class="muted">none read</span>'}</span></div>` : ""}<div class="site-meta">Declared in ${specPlace(raw.sp[0])}</div>`,
    );
  }

  function openEntry(i) {
    const raw = D.e[i];
    const e = entries[i];
    const isField = raw.k === "q";
    const u = e.unit;
    const subject = u ? u.id : S[raw.p];
    const servedBy = raw.u.length
      ? `${isField ? "Resolver" : "Handler"} ${code(u.name)} ${loc(raw.u[0], u.line, `${short(u.file)}:${u.line}`)}`
      : `Declared in ${raw.sp.length ? specPlace(raw.sp[0]) : "a spec"}. suss didn't find what serves this. ${notServedReason(raw)}`;
    const sig =
      isField && raw.sh
        ? `<p class="d-sig">${signature(S[raw.p], raw.sh[0], raw.sh[1])}</p>`
        : "";
    const unread =
      raw.nr === 1
        ? `<div class="callout callout-partial">${icon("partial", "i-partial")}<div><strong>Not read.</strong> Tables it reaches may be missing below.</div></div>`
        : "";
    const outcomes = outcomeRows(raw);
    showDrawer(
      `${icon("route", "i-go")}${isField ? "GraphQL field" : "Route"}`,
      `<header>
        <h2 class="d-title" id="drawer-title">${badge(raw)}<span>${esc(S[raw.p])}</span></h2>
        ${sig}
        <p class="d-sub">${servedBy}</p>
      </header>
      <div class="d-stats">${stat(n(isField ? raw.c.length : e.statuses.length), isField ? (raw.c.length === 1 ? "operation" : "operations") : e.statuses.length === 1 ? "status" : "statuses")}${stat(n(e.writes.size), "tables written", e.writes.size ? "w" : "")}${stat(n(e.reads.size), "tables read")}${stat(n(isField ? e.env.size : raw.c.length), isField ? "env vars" : raw.c.length === 1 ? "caller here" : "callers here")}</div>
      ${findingCallouts(raw, i)}
      ${unread}
      ${isField ? callersSection(raw, true) : ""}
      ${section("Returns", outcomes.length, outcomes.length ? limited(outcomes, 8) : "", { from: ["inspect", `suss inspect ${u ? u.file : ""}`] })}
      ${specSection(raw, e)}
      ${reachSections(e, `suss ask "what does ${subject} reach" --dir ${D.askDir}`)}
      ${isField ? "" : callersSection(raw, false)}
      ${gapSection(raw)}
      ${askLine(`what does ${subject} reach`)}`,
    );
  }

  function openType(t) {
    const type = types[t];
    const rows = type.fields
      .map((f) => {
        const where =
          f[4] !== null
            ? loc(f[4], unit(f[4]).line, short(unit(f[4]).file))
            : `<span class="muted">schema</span>`;
        const entry = f[5] !== null ? ` ${entryRef(f[5])}` : "";
        return `<tr><td class="f-type">${signature(S[f[0]], f[1], f[2])}</td><td>${where}${entry}</td></tr>`;
      })
      .join("");
    if (type.kind !== "object") {
      const members = type.members.map((m) =>
        type.kind === "union" ? typeHtml(m) : code(m),
      );
      showDrawer(
        `${icon("type", "i-go")}GraphQL ${type.kind}`,
        `<header><h2 class="d-title" id="drawer-title">${esc(type.name)}</h2><p class="d-sub">${TYPE_CONTENTS[type.kind](type)}</p></header>
        ${section(type.kind === "enum" ? "Values" : "Members", members.length, members.length ? limited(members, 24) : "")}`,
      );
      return;
    }
    showDrawer(
      `${icon("type", "i-go")}GraphQL type`,
      `<header><h2 class="d-title" id="drawer-title">${esc(type.name)}</h2><p class="d-sub">${plural(type.fields.length, "field", "fields")}, ${type.resolvers ? `${n(type.resolvers)} with a resolver in code` : "none with a resolver in code"}</p></header>
      ${section("Fields", type.fields.length, `<table class="fields"><tbody>${rows}</tbody></table>`)}`,
    );
  }

  function openTable(b) {
    const tb = tables[tableOf.get(b)];
    if (!tb) {
      return;
    }
    const label = boundary(b).label;
    const entriesAt = (ui, via) =>
      tb.writers
        .filter((e) =>
          (e.writes.get(b) || []).some(
            (item) => item[2] === ui && (via === null || item[3] === via),
          ),
        )
        .map((e) => e.i);
    const placeRows = (places, kind) =>
      places.map((p) => {
        const reach = kind === "w" ? entriesAt(p[0], p[1]) : [];
        const chips = reach.length
          ? `<div class="site-meta">${reach.slice(0, 6).map(entryRef).join(" ")}${reach.length > 6 ? ` and ${reach.length - 6} more` : ""}</div>`
          : "";
        return `<div class="site">${p[1] !== null ? `<div class="site-code">${code(S[p[1]])}</div>` : ""}<div class="site-meta"><span class="unit-name">${esc(unit(p[0]).name)}</span>${loc(p[0], null)}</div>${chips}</div>`;
      });
    const chips = (list) =>
      `<ul class="rows rows-grid">${list.map((e) => `<li class="row">${entryRef(e.i)}</li>`).join("")}</ul>`;
    showDrawer(
      `${icon("table", "i-table")}Table${tb.system ? ` · ${esc(tb.system)}` : ""}`,
      `<header><h2 class="d-title" id="drawer-title">${esc(tb.name)}</h2><p class="d-sub">${esc(label)}</p></header>
      <div class="d-stats">${stat(n(tb.writers.length), "routes write it", tb.writers.length ? "w" : "")}${stat(n(tb.readers.length), "routes read it")}${stat(n(tb.writePlaces.length), "places write it")}${stat(n(tb.readPlaces.length), "places read it")}</div>
      ${section("Places that write it", tb.writePlaces.length, tb.writePlaces.length ? limited(placeRows(tb.writePlaces, "w"), 6) : `<p class="empty-line">${icon("partial", "i-partial")}<span>No code suss read writes it.</span></p>`, { from: ["ask", `suss ask "what writes ${label}" --dir ${D.askDir}`] })}
      ${section("Places that read it", tb.readPlaces.length, tb.readPlaces.length ? limited(placeRows(tb.readPlaces, "r"), 6) : "", { closed: true, from: ["ask", `suss ask "what reads ${label}" --dir ${D.askDir}`] })}
      ${section("Routes that read it", tb.readers.length, tb.readers.length ? chips(tb.readers) : "", { closed: tb.readers.length > 24 })}
      ${askLine(`what writes ${label}`)}`,
    );
  }

  function openEnv(b) {
    const ev = envs[envOf.get(b)];
    if (!ev) {
      return;
    }
    const rows = ev.reads.map(
      (r) =>
        `<span class="unit-name">${esc(unit(r[1]).name)}</span> ${loc(r[1], null, `${short(unit(r[1]).file)}:${unit(r[1]).line}`)} <span class="badge" data-term="default">${r[2] !== 1 ? "no default" : r[3] === null || r[3] === undefined ? "default" : `default ${esc(S[r[3]])}`}</span>`,
    );
    showDrawer(
      `${icon("env", "i-env")}Environment variable`,
      `<header><h2 class="d-title" id="drawer-title">${esc(ev.name)}</h2></header>
      <div class="d-stats">${stat(n(ev.reads.length), ev.reads.length === 1 ? "place reads it" : "places read it")}${stat(n(ev.defaults), "with a default")}${stat(n(ev.entries.length), "routes reach a read")}${stat(n(new Set(ev.reads.map((r) => unit(r[1]).file)).size), "files")}</div>
      ${section("Where it is read", ev.reads.length, limited(rows, 10))}
      ${section("Routes that reach a read", ev.entries.length, ev.entries.length ? `<ul class="rows rows-grid">${ev.entries.map((e) => `<li class="row">${entryRef(e.i)}</li>`).join("")}</ul>` : "")}`,
    );
  }

  function openPage(i) {
    const p = pages[i];
    showDrawer(
      `${icon("route", "i-go")}Page`,
      `<header><h2 class="d-title" id="drawer-title">${esc(p.path)}</h2><p class="d-sub">${code(p.unit.name)} ${loc(p.ui, p.unit.line, `${short(p.unit.file)}:${p.unit.line}`)}</p></header>`,
    );
  }

  let lastFocus = null;
  function showDrawer(crumb, body) {
    const drawer = $("#drawer");
    if (drawer.hidden) {
      lastFocus = document.activeElement;
    }
    hideTip();
    $("#drawer-crumb").innerHTML = crumb;
    $("#drawer-body").innerHTML = body;
    $("#drawer-body").scrollTop = 0;
    drawer.hidden = false;
    $("#scrim").hidden = false;
    drawer.focus({ preventScroll: true });
    fillFindings();
  }

  function hideDrawer() {
    $("#drawer").hidden = true;
    $("#scrim").hidden = true;
    if (lastFocus && document.contains(lastFocus)) {
      lastFocus.focus({ preventScroll: true });
    }
  }

  const OPENERS = {
    entry: [openEntry, () => D.e.length],
    type: [openType, () => types.length],
    table: [openTable, () => D.b.length],
    env: [openEnv, () => D.b.length],
    page: [openPage, () => pages.length],
  };

  function openFromHash() {
    const m = /^#(entry|type|table|env|page)-(\d+)$/.exec(location.hash);
    if (!m) {
      if (!$("#drawer").hidden) {
        hideDrawer();
      }
      return;
    }
    const [opener, size] = OPENERS[m[1]];
    const i = Number(m[2]);
    if (i >= 0 && i < size()) {
      opener(i);
    }
  }

  function open(target) {
    if (location.hash === `#${target}`) {
      openFromHash();
      return;
    }
    location.hash = target;
  }

  function close() {
    try {
      history.replaceState(null, "", location.pathname + location.search);
    } catch (_err) {
      location.hash = "";
    }
    hideDrawer();
  }

  // ---------- hover cards ----------

  const TERMS = {
    writes: ["Writes", "Changes rows, here or in code it calls."],
    reads: ["Reads", "Queries the table, here or in code it calls."],
    through: ["Via", "The calls from the entry point to here."],
    partial: [
      "Calls not followed",
      "Some calls weren't followed. Lists may be short.",
    ],
    unread: ["Not read", "suss didn't read this code. Tables may be missing."],
    finding: ["Finding", "This and its caller disagree."],
    ops: ["Callers", "GraphQL operations in this repo that use it."],
    default: ["Default", "Used when the variable isn't set."],
    early: ["Early return", "Middleware returns this before the handler runs."],
    fnline: ["Function start", "Links to the function, not the exact line."],
    speconly: ["Spec only", "A spec declares it. No code serves it."],
  };
  const STATUS_WORDS = {
    200: "OK",
    201: "Created",
    204: "No content",
    301: "Moved permanently",
    302: "Found",
    303: "See other",
    304: "Not modified",
    400: "Bad request",
    401: "Unauthorized",
    403: "Forbidden",
    404: "Not found",
    409: "Conflict",
    422: "Unprocessable",
    429: "Too many requests",
    500: "Server error",
    503: "Unavailable",
  };

  function peekEntry(i) {
    const raw = D.e[i];
    const e = entries[i];
    const head = `<b>${badge(raw)} ${esc(S[raw.p])}</b>`;
    const where = e.unit
      ? `<div>${esc(e.unit.name)} · ${esc(short(e.unit.file))}:${e.unit.line}</div>`
      : "<div>spec only</div>";
    const tableRow = `<span class="verb verb-write">${icon("write", "i-write")}${plural(e.writes.size, "table", "tables")}</span><span class="verb verb-read">${icon("read", "i-read")}${plural(e.reads.size, "table", "tables")}</span>`;
    const statuses =
      raw.k === "h"
        ? `<div class="tip-row">${e.statuses.map(statusPill).join(" ")}</div>`
        : raw.sh
          ? `<div class="tip-row"><code>${esc(S[raw.sh[1]])}</code></div>`
          : "";
    return `${head}${where}${statuses}<div class="tip-row">${tableRow}${raw.nr === 1 ? `<span>${icon("partial", "i-partial")} not read</span>` : ""}</div>`;
  }

  function peekTable(b) {
    const tb = tables[tableOf.get(b)];
    if (!tb) {
      return "";
    }
    return `<b>${icon("table", "i-table")}${esc(tb.name)}</b><div>${esc(boundary(b).label)}</div><div class="tip-row"><span class="verb verb-write">${icon("write", "i-write")}${plural(tb.writers.length, "route", "routes")}</span><span class="verb verb-read">${icon("read", "i-read")}${plural(tb.readers.length, "route", "routes")}</span></div>`;
  }

  function tipFor(el) {
    if (el.dataset.peek) {
      const [kind, idx] = el.dataset.peek.split("-");
      return kind === "entry" ? peekEntry(Number(idx)) : peekTable(Number(idx));
    }
    if (el.dataset.tip) {
      return `<code>${esc(el.dataset.tip)}</code>`;
    }
    if (el.dataset.term && TERMS[el.dataset.term]) {
      const [title, text] = TERMS[el.dataset.term];
      return `<b>${esc(title)}</b>${esc(text)}`;
    }
    if (el.dataset.status) {
      const s = el.dataset.status;
      return s === "?"
        ? "<b>Unknown status</b>The code sets it at runtime."
        : `<b>${esc(s)} ${esc(STATUS_WORDS[s] || "")}</b>Returned on some path.`;
    }
    return "";
  }

  const tip = $("#tip");
  let tipTarget = null;
  function showTip(el) {
    const html = tipFor(el);
    if (!html) {
      return;
    }
    tipTarget = el;
    tip.innerHTML = html;
    tip.hidden = false;
    const box = el.getBoundingClientRect();
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    const x = Math.min(Math.max(8, box.left), window.innerWidth - w - 8);
    const below = box.bottom + 6;
    const y = below + h > window.innerHeight - 8 ? box.top - h - 6 : below;
    tip.style.left = `${x}px`;
    tip.style.top = `${Math.max(8, y)}px`;
  }

  function hideTip() {
    tip.hidden = true;
    tipTarget = null;
  }

  const TIP_TARGETS = "[data-term], [data-peek], [data-status], [data-tip]";
  document.addEventListener("mouseover", (ev) => {
    const el = ev.target.closest(TIP_TARGETS);
    if (el && el !== tipTarget) {
      showTip(el);
      return;
    }
    if (!el && tipTarget) {
      hideTip();
    }
  });
  document.addEventListener("focusin", (ev) => {
    const el = ev.target.closest?.(TIP_TARGETS);
    if (el) {
      showTip(el);
      return;
    }
    hideTip();
  });
  window.addEventListener("scroll", hideTip, { passive: true, capture: true });

  // ---------- jump-to search ----------

  const GROUP_ORDER = [
    "GraphQL fields",
    "Routes",
    "Types",
    "Pages",
    "Tables",
    "Env vars",
  ];
  const index = [];
  entries.forEach((e) => {
    const raw = D.e[e.i];
    index.push({
      group: e.gql ? "GraphQL fields" : "Routes",
      key: `entry-${e.i}`,
      label: e.gql ? `${S[raw.m]}.${S[raw.p]}` : `${S[raw.m]} ${S[raw.p]}`,
      side: e.unit ? e.unit.name : "spec",
      text: e.text,
    });
  });
  types.forEach((t) =>
    index.push({
      group: "Types",
      key: `type-${t.i}`,
      label: t.name,
      side: plural(t.fields.length, "field", "fields"),
      text: t.text,
    }),
  );
  pages.forEach((p) =>
    index.push({
      group: "Pages",
      key: `page-${p.i}`,
      label: p.path,
      side: p.unit.name,
      text: p.text,
    }),
  );
  tables.forEach((t) =>
    index.push({
      group: "Tables",
      key: `table-${t.b}`,
      label: t.name,
      side: `written by ${plural(t.writers.length, "route", "routes")}`,
      text: t.text,
    }),
  );
  envs.forEach((e) =>
    index.push({
      group: "Env vars",
      key: `env-${e.b}`,
      label: e.name,
      side: `read in ${plural(e.reads.length, "place", "places")}`,
      text: e.text,
    }),
  );

  const q = $("#q");
  const results = $("#results");
  let hits = [];
  let cursor = 0;

  function search(text) {
    const terms = text.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) {
      return [];
    }
    const scored = [];
    for (const entry of index) {
      const label = entry.label.toLowerCase();
      if (!terms.every((t) => entry.text.includes(t) || label.includes(t))) {
        continue;
      }
      scored.push({
        entry,
        score: (label.includes(terms[0]) ? 0 : 1) + label.length / 1000,
      });
    }
    scored.sort((a, b) => a.score - b.score);
    const perGroup = {};
    return scored
      .filter(({ entry }) => {
        perGroup[entry.group] = (perGroup[entry.group] || 0) + 1;
        return perGroup[entry.group] <= 8;
      })
      .map((x) => x.entry)
      .sort(
        (a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group),
      );
  }

  const GROUP_ICONS = {
    "GraphQL fields": ["route", "i-go"],
    Routes: ["route", "i-go"],
    Types: ["type", "i-go"],
    Pages: ["route", "i-go"],
    Tables: ["table", "i-table"],
    "Env vars": ["env", "i-env"],
  };

  function renderResults() {
    hits = search(q.value);
    cursor = Math.min(cursor, Math.max(0, hits.length - 1));
    if (!q.value.trim()) {
      results.hidden = true;
      q.setAttribute("aria-expanded", "false");
      return;
    }
    let lastGroup = "";
    const rows = hits
      .map((h, i) => {
        const head =
          h.group !== lastGroup
            ? `<div class="res-group">${icon(GROUP_ICONS[h.group][0], GROUP_ICONS[h.group][1])}${esc(h.group)}</div>`
            : "";
        lastGroup = h.group;
        return `${head}<button type="button" class="res" role="option" id="res-${i}" data-open="${h.key}" aria-selected="${i === cursor}"><span class="res-main">${esc(h.label)}</span><span class="res-side">${esc(h.side)}</span></button>`;
      })
      .join("");
    results.innerHTML = hits.length
      ? `${rows}<div class="res-hint"><span><kbd>↑</kbd> <kbd>↓</kbd> move</span><span><kbd>Enter</kbd> open</span><span><kbd>Esc</kbd> close</span></div>`
      : `<div class="res-empty">Nothing matches “${esc(q.value)}”.</div>`;
    results.hidden = false;
    q.setAttribute("aria-expanded", "true");
    if (hits.length) {
      q.setAttribute("aria-activedescendant", `res-${cursor}`);
    }
  }

  q.addEventListener("input", () => {
    cursor = 0;
    renderResults();
  });
  q.addEventListener("focus", renderResults);
  q.addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      if (hits.length) {
        cursor =
          (cursor + (ev.key === "ArrowDown" ? 1 : hits.length - 1)) %
          hits.length;
        renderResults();
        const el = $(`#res-${cursor}`);
        if (el) {
          el.scrollIntoView({ block: "nearest" });
        }
      }
      return;
    }
    if (ev.key === "Enter") {
      ev.preventDefault();
      if (hits[cursor]) {
        results.hidden = true;
        open(hits[cursor].key);
      }
      return;
    }
    if (ev.key === "Escape") {
      q.value = "";
      results.hidden = true;
      q.blur();
    }
  });

  // ---------- events ----------

  function applyFacetLink(spec) {
    const colon = spec.indexOf(":");
    const tab = spec.slice(0, colon);
    const rest = spec.slice(colon + 1);
    if (!ITEMS[tab] || !$(`[role="tab"][data-tab="${tab}"]`)) {
      return;
    }
    state.tab = tab;
    state.facets[tab] = {};
    state.text[tab] = "";
    for (const pair of rest.split(",").filter(Boolean)) {
      const eq = pair.indexOf("=");
      state.facets[tab][pair.slice(0, eq)] = pair.slice(eq + 1);
    }
    renderList();
    $("#explore").scrollIntoView({
      behavior: reduceMotion ? "auto" : "smooth",
    });
  }

  const CLICKS = [
    [
      "[data-open]",
      (el, ev) => {
        ev.preventDefault();
        results.hidden = true;
        open(el.dataset.open);
      },
    ],
    [
      "[data-facet]",
      (el, ev) => {
        ev.preventDefault();
        applyFacetLink(el.dataset.facet);
      },
    ],
    [
      '[role="tab"][data-tab]',
      (el) => {
        state.tab = el.dataset.tab;
        renderList();
      },
    ],
    [
      "[data-facet-id]",
      (el) => {
        const facets = state.facets[state.tab];
        const { facetId, facetValue } = el.dataset;
        if (facets[facetId] === facetValue) {
          delete facets[facetId];
        } else {
          facets[facetId] = facetValue;
        }
        state.shown[state.tab] = 0;
        renderList();
      },
    ],
    [
      "[data-clear]",
      () => {
        state.facets[state.tab] = {};
        state.text[state.tab] = "";
        renderList();
      },
    ],
    [
      "[data-facet-more]",
      (el) => {
        state.more[el.dataset.facetMore] = true;
        renderFacets();
      },
    ],
    [
      "[data-more-rows]",
      () => {
        state.shown[state.tab] =
          (state.shown[state.tab] || PAGE_ROWS) + PAGE_ROWS;
        renderList();
      },
    ],
    [
      "[data-toggle-conds]",
      (el) => {
        const list = el.nextElementSibling;
        list.hidden = !list.hidden;
        el.setAttribute("aria-expanded", String(!list.hidden));
      },
    ],
    [
      "[data-show-all]",
      (el) => {
        el.previousElementSibling
          .querySelectorAll("[data-rest]")
          .forEach((li) => {
            li.hidden = false;
          });
        el.remove();
      },
    ],
  ];

  document.addEventListener("click", (ev) => {
    if (!ev.target.closest(".search")) {
      results.hidden = true;
      q.setAttribute("aria-expanded", "false");
    }
    for (const [selector, handle] of CLICKS) {
      const el = ev.target.closest(selector);
      if (el) {
        handle(el, ev);
        return;
      }
    }
  });

  $("#filter").addEventListener("input", (ev) => {
    state.text[state.tab] = ev.target.value;
    state.shown[state.tab] = 0;
    renderList();
    ev.target.focus();
  });
  $("#close").addEventListener("click", close);
  $("#scrim").addEventListener("click", close);
  window.addEventListener("hashchange", openFromHash);
  document.addEventListener("keydown", (ev) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(
      document.activeElement.tagName,
    );
    if (ev.key === "Escape") {
      hideTip();
      if (!$("#drawer").hidden) {
        close();
      }
      return;
    }
    const palette =
      ev.key === "/" ||
      ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "k");
    if (palette && (!typing || ev.key !== "/")) {
      ev.preventDefault();
      q.focus();
      q.select();
    }
  });

  const editor = $("#editor");
  if (!D.repos.some((r) => r[1])) {
    editor.querySelector('option[value="github"]')?.remove();
  }
  // A page with no folder on this machine can only link to GitHub.
  if (!D.roots.some((root) => root)) {
    editor.closest("label")?.remove();
  }
  editor.value = scheme;
  editor.addEventListener("change", () => {
    scheme = editor.value;
    try {
      localStorage.setItem("suss-map-editor", scheme);
    } catch (_err) {
      // the choice lasts until the page closes
    }
    relink(document.body);
  });

  // On a narrow screen the filters start folded so the list comes first.
  if (window.innerWidth <= 920) {
    $("#facets-wrap").open = false;
  }

  // ---------- colour in source excerpts ----------

  const KEYWORDS = {
    ruby: "def end if elsif else unless return do while until class module self nil true false and or not then yield begin rescue ensure raise case when new",
    python:
      "def return if elif else for while in not and or is None True False class import from as with try except finally raise lambda yield await async pass",
    js: "function return if else for while const let var new this null undefined true false class import from export await async try catch finally throw typeof of in",
  };
  const KEYWORD_SETS = Object.fromEntries(
    Object.entries(KEYWORDS).map(([lang, words]) => [
      lang,
      new Set(words.split(" ")),
    ]),
  );
  const TOKEN =
    /(#.*$|\/\/.*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d+(?:\.\d+)?\b)|(:[A-Za-z_]\w*)|([A-Za-z_]\w*)/g;

  function tokenClass(m, lang, words) {
    if (m[1]) {
      return (lang === "js" ? m[1].startsWith("//") : m[1].startsWith("#"))
        ? "tk-com"
        : null;
    }
    if (m[2]) {
      return "tk-str";
    }
    if (m[3]) {
      return "tk-num";
    }
    if (m[4]) {
      return lang === "ruby" ? "tk-sym" : null;
    }
    return words.has(m[5]) ? "tk-kw" : null;
  }

  function colour(el) {
    const lang = el.dataset.lang;
    const words = KEYWORD_SETS[lang] || KEYWORD_SETS.js;
    const text = el.textContent;
    const parts = [];
    let at = 0;
    for (const m of text.matchAll(TOKEN)) {
      parts.push(esc(text.slice(at, m.index)));
      at = m.index + m[0].length;
      const cls = tokenClass(m, lang, words);
      parts.push(cls ? `<span class="${cls}">${esc(m[0])}</span>` : esc(m[0]));
    }
    parts.push(esc(text.slice(at)));
    el.innerHTML = parts.join("");
  }

  document.querySelectorAll(".excerpt code.src[data-lang]").forEach(colour);
  relink(document.body);
  renderList();
  openFromHash();
})();
