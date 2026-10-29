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
```

`E2B_API_KEY_B` is optional. `PROBE_TOKEN` is supported for backwards
compatibility with existing deployments.

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
