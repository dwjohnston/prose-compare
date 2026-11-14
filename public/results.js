import { api, authControl, commitUrl, el, money, pageData, shortSha } from "./common.js";

const page = pageData();
const app = document.getElementById("app");
let view = null;
let config = { signedIn: page.signedIn, canSignIn: page.canSignIn, passwordRequired: page.passwordRequired };
const panes = [0, 1];
const traces = new Map();
let poll = null;

const STATUS_TEXT = {
  triggered: "Triggered",
  load_failed: "Load failed",
  not_triggered: "Not triggered",
  fetched_instead: "Fetched instead",
};

function laneName(lane) {
  if (lane.label) return lane.label;
  if (lane.skills.length === 0) return `Lane ${lane.order + 1}: baseline`;
  return `Lane ${lane.order + 1}: ${lane.skills.map((s) => s.snapshot.name).join(" + ")}`;
}

function cell(lane, snapshot) {
  const ls = lane.skills.find((s) => s.skill_snapshot_id === snapshot.id);
  if (!ls) return el("td", { class: "status not-in-lane", text: "Not in lane" });
  if (!ls.invocation_status) return el("td", { class: "status pending", text: lane.status === "failed" ? "–" : "…" });
  const extra = [];
  if (ls.invocation_status === "triggered") {
    extra.push(`step ${ls.first_invoked_step}`);
    if (ls.before_first_text === 0) extra.push("after the answer");
  }
  const files = ls.files_read ? JSON.parse(ls.files_read) : [];
  if (files.length) extra.push(`${files.length} file${files.length > 1 ? "s" : ""} read`);
  return el(
    "td",
    { class: `status ${ls.invocation_status}`, title: files.join("\n") || undefined },
    STATUS_TEXT[ls.invocation_status],
    extra.length ? el("div", { class: "small muted", text: extra.join(" · ") }) : null,
  );
}

function summaryTable() {
  return el(
    "table",
    { class: "summary" },
    el(
      "thead",
      {},
      el(
        "tr",
        {},
        el("th", { text: "Lane" }),
        view.snapshots.map((s) => el("th", { title: s.description }, s.name)),
        el("th", { text: "Status" }),
        el("th", { text: "Tokens in / out" }),
        el("th", { text: "Cost" }),
        el("th", { text: "Duration" }),
      ),
    ),
    el(
      "tbody",
      {},
      view.lanes.map((lane) =>
        el(
          "tr",
          {},
          el("th", { scope: "row", text: laneName(lane) }),
          view.snapshots.map((s) => cell(lane, s)),
          el("td", { class: `lane-status ${lane.status}`, title: lane.error || undefined, text: lane.status + (lane.error ? " ⚠" : "") }),
          el("td", { text: lane.tokens_input === null ? "–" : `${lane.tokens_input.toLocaleString()} / ${lane.tokens_output.toLocaleString()}` }),
          el("td", { text: money(lane.cost_usd) }),
          el("td", { text: lane.duration_ms === null ? "–" : `${(lane.duration_ms / 1000).toFixed(1)}s` }),
        ),
      ),
    ),
  );
}

async function plainOutput(lane, box) {
  try {
    const res = await fetch(`/api/lanes/${lane.id}/output`);
    box.replaceChildren(el("pre", { class: "plain-output", text: res.ok ? await res.text() : "No output yet." }));
  } catch {
    box.replaceChildren(el("p", { class: "muted", text: "Couldn't load the output." }));
  }
}

function pane(i) {
  const select = el(
    "select",
    {
      "aria-label": `Lane shown in pane ${i + 1}`,
      onchange: (e) => {
        panes[i] = Number(e.target.value);
        render();
      },
    },
    view.lanes.map((lane, idx) => el("option", { value: idx, selected: idx === panes[i], text: laneName(lane) })),
  );
  const lane = view.lanes[panes[i]];
  const box = el("div", { class: "pane-body" });
  if (!lane) box.append(el("p", { class: "muted", text: "No lane." }));
  else if (lane.status === "queued" || lane.status === "running") box.append(el("p", { class: "muted", text: lane.status === "queued" ? "Queued…" : "Running…" }));
  else if (page.renderOrigin) {
    // Model output is untrusted. It renders on a separate origin, under a script-free CSP, in a sandboxed frame.
    box.append(
      el("iframe", {
        src: `${page.renderOrigin}/o/${lane.id}`,
        sandbox: "allow-popups allow-popups-to-escape-sandbox",
        referrerpolicy: "no-referrer",
        loading: "lazy",
        title: `Output of ${laneName(lane)}`,
      }),
    );
  } else plainOutput(lane, box);
  if (lane && lane.error) box.prepend(el("p", { class: "error small", text: lane.error }));
  return el("div", { class: "pane" }, select, box);
}

function traceSection(lane) {
  const body = el("div", { class: "trace-body" });
  const details = el(
    "details",
    {
      ontoggle: async () => {
        if (!details.open || traces.has(lane.id)) return;
        body.replaceChildren(el("p", { class: "muted small", text: "Loading…" }));
        try {
          traces.set(lane.id, await api(`/api/lanes/${lane.id}/trace`));
        } catch (err) {
          body.replaceChildren(el("p", { class: "muted small", text: err.message }));
          return;
        }
        fillTrace(lane, body);
      },
    },
    el("summary", { text: `Tool calls: ${laneName(lane)}` }),
    body,
  );
  if (traces.has(lane.id)) {
    details.open = true;
    fillTrace(lane, body);
  }
  return details;
}

function fillTrace(lane, body) {
  const t = traces.get(lane.id);
  const items = t.trace.map((e) =>
    el(
      "li",
      { class: e.status === "error" ? "error" : "" },
      el("span", { class: "mono small muted", text: `step ${e.step} · ` }),
      el("strong", { text: e.tool }),
      " ",
      el("span", { class: "mono", text: e.target }),
      e.status === "error" ? el("span", { class: "small", text: ` — ${e.error}` }) : null,
    ),
  );
  body.replaceChildren(
    items.length ? el("ol", { class: "trace" }, items) : el("p", { class: "muted small", text: "No tool calls." }),
    t.anomalies.length
      ? el("p", { class: "error small", text: `Anomaly: skill calls for names outside this lane: ${t.anomalies.map((a) => a.name).join(", ")}` })
      : null,
    t.errors.length ? el("p", { class: "error small", text: `Errors: ${t.errors.join("; ")}` }) : null,
    t.eventsTruncated ? el("p", { class: "muted small", text: "The event log was truncated." }) : null,
  );
}

function header() {
  const c = view.comparison;
  return el(
    "section",
    { class: "result-head" },
    el("h1", { text: "Comparison" }),
    el("blockquote", { class: "prompt", text: c.prompt }),
    el(
      "p",
      { class: "muted small" },
      `Model ${c.model} · harness ${c.harness_version} · ${new Date(c.created_at).toLocaleString()} · status ${c.status} · total ${money(c.total_cost_usd)}`,
      c.rerun_of ? el("span", {}, " · re-run of ", el("a", { href: `/c/${c.rerun_of}`, text: c.rerun_of })) : null,
    ),
    el(
      "ul",
      { class: "lane-skills small" },
      view.lanes.map((lane) =>
        el(
          "li",
          {},
          el("strong", { text: laneName(lane) }),
          lane.skills.length === 0 ? el("span", { class: "muted", text: " — no skills" }) : ": ",
          lane.skills.map((s, i) => [
            i ? ", " : "",
            el("a", { href: commitUrl(s.snapshot), rel: "noopener noreferrer", target: "_blank", text: `${s.snapshot.owner}/${s.snapshot.repo}${s.snapshot.path ? `/${s.snapshot.path}` : ""}@${shortSha(s.snapshot.commit_sha)}` }),
          ]),
        ),
      ),
    ),
  );
}

function actions() {
  const msg = el("span", { class: "error small", role: "status" });
  const canRun = !config.passwordRequired || config.signedIn;
  return el(
    "div",
    { class: "row actions" },
    canRun
      ? el("button", {
          type: "button",
          text: "Run again",
          title: "Re-run the same pinned skills, prompt and model as a new comparison",
          onclick: async () => {
            try {
              const { id } = await api(`/api/comparisons/${view.comparison.id}/rerun`, { method: "POST", body: {} });
              location.href = `/c/${id}`;
            } catch (err) {
              msg.textContent = err.message;
            }
          },
        })
      : null,
    config.signedIn
      ? el("button", {
          type: "button",
          class: "danger",
          text: "Delete",
          onclick: async () => {
            if (!confirm("Delete this comparison? This can't be undone.")) return;
            try {
              await api(`/api/comparisons/${view.comparison.id}`, { method: "DELETE" });
              location.href = "/";
            } catch (err) {
              msg.textContent = err.message;
            }
          },
        })
      : null,
    msg,
  );
}

function render() {
  authControl(config, async (signedIn) => {
    config = await api("/api/config");
    config.signedIn = signedIn && config.signedIn;
    render();
  });
  if (!view) return;
  if (panes[1] >= view.lanes.length) panes[1] = Math.max(0, view.lanes.length - 1);
  app.replaceChildren(
    header(),
    actions(),
    el("h2", { text: "Summary" }),
    el("div", { class: "table-wrap" }, summaryTable()),
    el("p", { class: "muted small" }, "Triggered means the harness's event log has a completed ", el("code", { text: "skill" }), " tool call naming that skill. The output text is never used for this."),
    el("h2", { text: "Outputs" }),
    el("div", { class: "reader" }, pane(0), pane(1)),
    el("h2", { text: "Tool-call traces" }),
    view.lanes.map(traceSection),
  );
}

async function load() {
  if (page.missing) {
    app.replaceChildren(el("p", { text: "Comparison not found." }));
    return;
  }
  try {
    view = await api(`/api/comparisons/${page.id}`);
  } catch (err) {
    app.replaceChildren(el("p", { class: "error", text: err.message }));
    return;
  }
  render();
  const busy = view.comparison.status === "queued" || view.comparison.status === "running";
  clearTimeout(poll);
  if (busy) poll = setTimeout(load, 5000);
}

load();
