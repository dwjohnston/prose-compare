# Hostile test skills

`skills.ts` defines the hostile skills from SPEC.md ("Remaining tasks") as an in-memory GitHub repo, and
`hostile.test.ts` runs them through the real fetch → validate → materialise code and the outbound policy.
CI (`bun test`) fails if any gets through.

| Case | Covered here (no sandbox) | Needs a live sandbox |
| --- | --- | --- |
| `..` paths | Rejected at link parse, listing and materialise | Nothing lands outside `/work/.opencode/skills/<name>/` |
| Symlink to `/proc/self/environ` | Rejected (listing type and target-path mismatch) | `read` can't reach `/proc/self/environ`; env holds only the placeholder key |
| Nested `SKILL.md` | Rejected | — |
| Submodule | Rejected (both listing styles) | — |
| `.opencode/plugins/*.ts`, `opencode.json`, `AGENTS.md` | Rejected | Plugin never executes (project config is also off) |
| Body that runs a shell command | Passes fetch (it's text); `shell` has no allow rule | Run shows the shell call denied, no exfil request in outbound logs |
| Description says fetch `169.254.169.254` | Passes fetch; outbound policy denies metadata, loopback, private and odd-port hosts | Run shows the fetch refused by the outbound Worker |

The live column needs a deployed Worker with Workers Paid (Sandboxes) and an OpenRouter key, so it isn't in
CI yet. To run it by hand once deployed: host the `shell-body` and `ssrf` skills in a public repo, submit
one comparison with a lane each, and check the result's trace shows `shell` denied / the metadata fetch
failing, and that the outbound Worker logs (`wrangler tail`) show no request to `evil.example` or
`169.254.169.254` leaving Cloudflare.
