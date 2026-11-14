import { api, authControl, mount, el, money, pageData, shortSha } from "./common.js";

let config = pageData();
const app = document.getElementById("app");

// Lanes: { label, baseline, links: [{ url, state: "idle"|"loading"|"ok"|"error", info, error }] }
const state = {
  prompt: "",
  model: config.defaultModel,
  lanes: [
    { label: "Baseline (no skills)", baseline: true, links: [] },
    { label: "", baseline: false, links: [{ url: "", state: "idle" }] },
  ],
  submitting: false,
  error: "",
};

async function refreshConfig() {
  config = await api("/api/config");
  render();
}

function canSubmit() {
  if (config.passwordRequired && !config.signedIn) return { ok: false, reason: config.canSignIn ? "Sign in to run comparisons." : "Submissions need a password that isn't configured yet." };
  if (!config.credit.ok) return { ok: false, reason: config.credit.reason || "Submissions are disabled." };
  if (state.prompt.trim() === "") return { ok: false, reason: "Enter a prompt." };
  if (state.prompt.length > config.limits.maxPromptChars) return { ok: false, reason: "The prompt is too long." };
  if (state.lanes.length === 0) return { ok: false, reason: "Add at least one lane." };
  for (const lane of state.lanes) {
    for (const link of lane.links) {
      if (link.url.trim() === "") continue;
      if (link.state === "loading") return { ok: false, reason: "Still resolving links…" };
      if (link.state === "error") return { ok: false, reason: "Fix or remove the links that failed." };
    }
  }
  return { ok: true };
}

async function resolve(link) {
  const url = link.url.trim();
  if (url === "") {
    link.state = "idle";
    render();
    return;
  }
  link.state = "loading";
  link.error = "";
  render();
  try {
    link.info = await api("/api/resolve", { method: "POST", body: { url } });
    if (link.url.trim() === url) link.state = "ok";
  } catch (err) {
    if (link.url.trim() === url) {
      link.state = "error";
      link.error = err.message;
    }
  }
  render();
}

function linkRow(lane, link) {
  const input = el("input", {
    type: "url",
    class: "link-input",
    placeholder: "https://github.com/owner/repo/tree/main/skills/my-skill",
    value: link.url,
    "aria-label": "GitHub link to a skill",
    onpaste: () => setTimeout(() => {
      link.url = input.value;
      resolve(link);
    }),
    onchange: () => {
      link.url = input.value;
      resolve(link);
    },
  });
  let detail = null;
  if (link.state === "loading") detail = el("div", { class: "muted small", text: "Resolving…" });
  if (link.state === "error") detail = el("div", { class: "error small", text: link.error });
  if (link.state === "ok" && link.info) {
    const i = link.info;
    detail = el(
      "div",
      { class: "skill-info small" },
      el("strong", { text: i.name }),
      i.displayName !== i.name ? el("span", { class: "muted", text: ` (${i.displayName})` }) : null,
      el("span", { class: "muted", text: ` · ${i.owner}/${i.repo}${i.path ? `/${i.path}` : ""} @ ${shortSha(i.commitSha)}` }),
      el("div", { class: "desc", text: i.description }),
    );
  }
  return el(
    "div",
    { class: "link-row" },
    el(
      "div",
      { class: "row" },
      input,
      el("button", {
        type: "button",
        class: "icon",
        title: "Remove skill",
        "aria-label": "Remove skill",
        text: "×",
        onclick: () => {
          lane.links.splice(lane.links.indexOf(link), 1);
          render();
        },
      }),
    ),
    detail,
  );
}

function laneCard(lane, index) {
  const label = el("input", {
    type: "text",
    class: "label-input",
    placeholder: `Lane ${index + 1} label (optional)`,
    maxlength: config.limits.maxLabelChars,
    value: lane.label,
    "aria-label": "Lane label",
    oninput: (e) => {
      lane.label = e.target.value;
    },
  });
  return el(
    "section",
    { class: "lane" },
    el(
      "div",
      { class: "row lane-head" },
      el("span", { class: "lane-num", text: `${index + 1}` }),
      label,
      el("button", {
        type: "button",
        class: "link",
        text: "Remove lane",
        onclick: () => {
          state.lanes.splice(index, 1);
          render();
        },
      }),
    ),
    lane.links.length === 0 ? el("p", { class: "muted small", text: "No skills: this lane is a baseline." }) : null,
    lane.links.map((link) => linkRow(lane, link)),
    lane.links.length < config.limits.maxSkillsPerLane
      ? el("button", {
          type: "button",
          class: "link",
          text: "+ Add a skill",
          onclick: () => {
            lane.links.push({ url: "", state: "idle" });
            render();
          },
        })
      : el("p", { class: "muted small", text: `Max ${config.limits.maxSkillsPerLane} skills per lane.` }),
  );
}

async function submit() {
  const check = canSubmit();
  if (!check.ok) return;
  state.submitting = true;
  state.error = "";
  render();
  try {
    const body = {
      prompt: state.prompt,
      model: state.model,
      lanes: state.lanes.map((l) => ({ label: l.label, links: l.links.map((k) => k.url.trim()).filter(Boolean) })),
    };
    const { id } = await api("/api/comparisons", { method: "POST", body });
    location.href = `/c/${id}`;
  } catch (err) {
    state.submitting = false;
    state.error = err.where && err.where.lane !== undefined ? `Lane ${err.where.lane + 1}: ${err.message}` : err.message;
    render();
  }
}

function creditLine() {
  const c = config.credit;
  const parts = [];
  if (c.limitRemaining !== null) parts.push(`Credit left: ${money(c.limitRemaining)}${c.limit !== null ? ` of ${money(c.limit)}` : ""}`);
  else if (c.ok) parts.push("Credit: no limit set on the key");
  if (config.spentUsd !== null && config.spentUsd !== undefined) parts.push(`spent here: ${money(config.spentUsd)}`);
  return el("p", { class: c.ok ? "muted small" : "error small", text: c.ok ? parts.join(" · ") : c.reason });
}

function render() {
  const active = document.activeElement;
  const focusKey = active && active.dataset ? active.dataset.focusKey : undefined;
  authControl(config, () => refreshConfig());
  const check = canSubmit();
  const prompt = el("textarea", {
    id: "prompt",
    rows: 6,
    placeholder: "The writing task every lane gets, e.g. “Rewrite this paragraph for a general reader: …”",
    dataset: { focusKey: "prompt" },
    oninput: (e) => {
      state.prompt = e.target.value;
      counter.textContent = `${state.prompt.length} / ${config.limits.maxPromptChars}`;
      submitBtn.disabled = !canSubmit().ok || state.submitting;
      reason.textContent = canSubmit().ok ? "" : canSubmit().reason;
    },
  });
  prompt.value = state.prompt;
  const counter = el("span", { class: "muted small", text: `${state.prompt.length} / ${config.limits.maxPromptChars}` });
  const model = el(
    "select",
    { id: "model", onchange: (e) => (state.model = e.target.value) },
    config.models.map((m) => el("option", { value: m.slug, selected: m.slug === state.model, text: `${m.label}${m.slug === config.defaultModel ? " (default)" : ""}` })),
  );
  const submitBtn = el("button", { type: "button", class: "primary", text: state.submitting ? "Starting…" : "Run comparison", disabled: !check.ok || state.submitting, onclick: submit });
  const reason = el("span", { class: "muted small", text: check.ok ? "" : check.reason });
  const hasBaseline = state.lanes.some((l) => l.links.length === 0);

  mount(app, 
    el("h1", { text: "Compare skills on one prompt" }),
    el(
      "p",
      { class: "lede" },
      "Each lane loads its own set of SKILL.md files. Every lane gets the same prompt, model and harness. The results show whether each skill actually triggered, read from the harness's tool-call events.",
    ),
    el("label", { for: "prompt", class: "field-label", text: "Prompt" }),
    prompt,
    el("div", { class: "row spread" }, counter),
    el("div", { class: "row" }, el("label", { for: "model", class: "field-label", text: "Model" }), model, el("span", { class: "muted small", text: `Harness: ${config.harnessVersion}` })),
    el("h2", { text: "Lanes" }),
    state.lanes.map(laneCard),
    el(
      "div",
      { class: "row" },
      state.lanes.length < config.limits.maxLanes
        ? el("button", {
            type: "button",
            text: "+ Add lane",
            onclick: () => {
              state.lanes.push({ label: "", baseline: false, links: [{ url: "", state: "idle" }] });
              render();
            },
          })
        : el("span", { class: "muted small", text: `Max ${config.limits.maxLanes} lanes.` }),
      !hasBaseline && state.lanes.length < config.limits.maxLanes
        ? el("button", {
            type: "button",
            class: "link",
            text: "+ Add a no-skill baseline",
            onclick: () => {
              state.lanes.unshift({ label: "Baseline (no skills)", baseline: true, links: [] });
              render();
            },
          })
        : null,
    ),
    el(
      "aside",
      { class: "note small" },
      el("strong", { text: "Limits: " }),
      `${config.limits.maxLanes} lanes, ${config.limits.maxSkillsPerLane} skills per lane, ${config.limits.maxPromptChars} characters of prompt. Skills come from public GitHub repos, pinned to the commit they resolve to. `,
      "The harness can only load skills, read the skill's own files and fetch web pages: skills that need to run scripts, edit files or use MCP can't fully work here.",
    ),
    el("div", { class: "row submit-row" }, submitBtn, reason),
    creditLine(),
    state.error ? el("p", { class: "error", role: "alert", text: state.error }) : null,
  );
  if (focusKey) {
    const again = app.querySelector(`[data-focus-key="${focusKey}"]`);
    if (again) again.focus();
  }
}

render();
