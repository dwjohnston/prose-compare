// Shared helpers. All text goes in through textContent; nothing builds HTML from strings.
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (k === "dataset") Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  node.append(...nodes(children));
  return node;
}

/** Flatten any nesting of arrays, drop null/undefined/false, turn the rest into nodes. */
export function nodes(children) {
  return children
    .flat(Infinity)
    .filter((c) => c !== null && c !== undefined && c !== false)
    .map((c) => (c instanceof Node ? c : document.createTextNode(String(c))));
}

/** Replace a node's children with the given (possibly nested) children. */
export function mount(node, ...children) {
  node.replaceChildren(...nodes(children));
}

export function pageData() {
  return JSON.parse(document.getElementById("page-data").textContent);
}

export async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.status = res.status;
    err.where = data && data.where;
    throw err;
  }
  return data;
}

export function money(n) {
  if (n === null || n === undefined) return "–";
  return n < 0.01 && n > 0 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

export function shortSha(sha) {
  return sha ? sha.slice(0, 7) : "";
}

export function commitUrl(s) {
  const path = s.path ? `/${s.path.split("/").map(encodeURIComponent).join("/")}` : "";
  return `https://github.com/${encodeURIComponent(s.owner)}/${encodeURIComponent(s.repo)}/tree/${s.commit_sha || s.commitSha}${path}`;
}

/** Sign-in / sign-out control in the header. Calls onChange(signedIn) after a change. */
export function authControl({ signedIn, canSignIn }, onChange) {
  const slot = document.getElementById("auth-slot");
  slot.replaceChildren();
  if (!canSignIn) return;
  if (signedIn) {
    slot.append(
      el("span", { class: "muted", text: "Signed in · " }),
      el("button", {
        class: "link",
        type: "button",
        text: "Sign out",
        onclick: async () => {
          await api("/api/logout", { method: "POST", body: {} });
          onChange(false);
        },
      }),
    );
    return;
  }
  const input = el("input", { type: "password", placeholder: "Password", autocomplete: "current-password", "aria-label": "Password" });
  const msg = el("span", { class: "error", role: "status" });
  const form = el(
    "form",
    {
      class: "signin",
      onsubmit: async (e) => {
        e.preventDefault();
        msg.textContent = "";
        try {
          await api("/api/login", { method: "POST", body: { password: input.value } });
          onChange(true);
        } catch (err) {
          msg.textContent = err.message;
        }
      },
    },
    input,
    el("button", { type: "submit", text: "Sign in" }),
    msg,
  );
  slot.append(form);
}
