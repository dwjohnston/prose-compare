import { api, authControl, el, money, mount, pageData } from "./common.js";

let config = pageData();
const app = document.getElementById("app");
const items = [];
let nextCursor = null;
let loading = false;
let error = "";
let loaded = false;

async function loadMore() {
  if (loading) return;
  loading = true;
  render();
  try {
    const q = nextCursor ? `?cursor=${encodeURIComponent(nextCursor)}` : "";
    const page = await api(`/api/comparisons${q}`);
    items.push(...page.items);
    nextCursor = page.nextCursor;
    error = "";
  } catch (err) {
    error = err.message;
  }
  loading = false;
  loaded = true;
  render();
}

function row(c) {
  const when = new Date(c.created_at);
  return el(
    "tr",
    {},
    el("td", { class: "nowrap small muted", title: when.toISOString(), text: when.toLocaleString() }),
    el(
      "td",
      { class: "prompt-cell" },
      el("a", { href: `/c/${c.id}`, text: c.prompt.length >= 280 ? `${c.prompt}…` : c.prompt }),
      el("div", { class: "small muted", text: c.skill_names ? `Skills: ${c.skill_names}` : "No skills (baseline only)" }),
    ),
    el("td", { class: "small", text: c.model }),
    el("td", { class: "small", text: String(c.lane_count) }),
    el("td", { class: `small status-${c.status}`, text: c.status + (c.rerun_of ? " · re-run" : "") + (c.force_skills ? " · forced" : "") }),
    el("td", { class: "small nowrap", text: money(c.total_cost_usd) }),
  );
}

function render() {
  authControl(config, async () => {
    config = await api("/api/config");
    render();
  });
  mount(
    app,
    el("h1", { text: "All results" }),
    el("p", { class: "lede" }, "Every comparison run here, newest first. ", el("a", { href: "/", text: "Start a new one" }), "."),
    items.length
      ? el(
          "div",
          { class: "table-wrap" },
          el(
            "table",
            { class: "list" },
            el(
              "thead",
              {},
              el("tr", {}, ["When", "Prompt", "Model", "Lanes", "Status", "Cost"].map((h) => el("th", { text: h }))),
            ),
            el("tbody", {}, items.map(row)),
          ),
        )
      : loaded && !error
        ? el("p", { class: "muted", text: "No comparisons yet." })
        : null,
    error ? el("p", { class: "error", text: error }) : null,
    loading ? el("p", { class: "muted small", text: "Loading…" }) : null,
    nextCursor && !loading ? el("button", { type: "button", text: "Load more", onclick: loadMore }) : null,
  );
}

loadMore();
