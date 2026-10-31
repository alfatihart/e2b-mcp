# e2b-mcp

An MCP server for creating and managing isolated E2B sandboxes from a
Cloudflare Worker.

## Features

- Create, connect to, list, extend, and terminate E2B sandboxes.
- Run commands in the foreground or in the background.
- Read and write text files in a sandbox.
- Use prebuilt base, Node.js/PostgreSQL, or Docker/Supabase development
  environments.
- Support multiple E2B API keys with fallback when an account reaches its
  limit.

## MCP tools

| Tool | Description |
| --- | --- |
| `e2b_create` | Create a sandbox from a template. |
| `e2b_run` | Run a command in the sandbox. |
| `e2b_read_file` / `e2b_write_file` | Read or write a text file. |
| `e2b_list` | List active sandboxes. |
| `e2b_extend` | Extend a sandbox timeout. |
| `e2b_kill` | Terminate a sandbox. |

The available template names and their contents are defined in
[`templates/templates.mjs`](./templates/templates.mjs).

## Requirements

- Node.js 22.19 or newer.
- An E2B account and API key.
- A Cloudflare Workers account for deployment.

## Local development

Install dependencies:

```powershell
npm ci
```

Run the Worker locally:

```powershell
npx wrangler dev
```

Validate the Worker bundle without deploying:

```powershell
npm run check
```

## Configuration

Set secrets through Wrangler. Do not commit credentials or local Wrangler
configuration files:

```powershell
npx wrangler secret put MCP_TOKEN
npx wrangler secret put E2B_API_KEY_A
npx wrangler secret put E2B_API_KEY_B
npx wrangler secret put GITHUB_TOKEN_SANDBOX
```

`E2B_API_KEY_B` is optional. With `account: "auto"`, sandboxes are created in
account A and fall back to account B only when A hits a rate limit, quota, or
credit error. Build the templates in every configured account, because E2B
templates belong to one account.

`GITHUB_TOKEN_SANDBOX` is optional. When set, it is exposed as `GITHUB_TOKEN`
and `GH_TOKEN` only in the `node-postgres` and `docker-supabase` sandboxes, so
agents can clone private repositories with `gh repo clone`. It is never
injected into `base`, which is meant for untrusted code. Use a fine-grained,
read-only token limited to the repositories you need, with an expiry date.

`PROBE_TOKEN` is supported for backwards compatibility with existing
deployments.

## Security model

- Every request to `/mcp` and `/probe` requires `Authorization: Bearer <MCP_TOKEN>`.
  Only `/health` is public.
- Secrets live only in Wrangler secrets. `wrangler.jsonc`, `.dev.vars`, and
  `.env*` are ignored by git.
- Anything running inside a sandbox can read that sandbox's environment
  variables. Never pass production credentials through `envs`.
- The database URLs in `TEMPLATE_ENVS` point to throwaway databases on
  `127.0.0.1` inside each sandbox. They are not reachable from outside.

## Deploy

```powershell
npx wrangler deploy
```

After deployment, register the Worker endpoint with the MCP client or
platform of your choice.

## Build E2B templates

Build a template using the E2B API key available in the current shell:

```powershell
$env:E2B_API_KEY = "<your E2B API key>"
npm run build:templates -- v2
npm run build:templates -- v1
```

Build both templates with:

```powershell
npm run build:templates -- all
```

Template builds consume E2B resources. Review the template definitions before
building them in a production account.

## License

Apache License 2.0. See [LICENSE](LICENSE).
