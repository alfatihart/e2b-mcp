// e2b-mcp — server MCP (Streamable HTTP, stateless) di Cloudflare Workers untuk sandbox E2B.
//   POST /mcp     endpoint MCP (JSON-RPC), wajib Authorization: Bearer <MCP_TOKEN>
//   GET  /health  "ok" tanpa auth
//   POST /probe   uji cepat (create → command → file → kill), wajib Bearer
// Secret: MCP_TOKEN (atau PROBE_TOKEN lama), E2B_API_KEY_A, E2B_API_KEY_B (opsional).
import { Sandbox, CommandExitError, RateLimitError } from "e2b";

const SERVER_INFO = { name: "e2b-mcp", version: "0.3.0" };
const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_OUTPUT = 20_000; // karakter per stdout/stderr yang dikembalikan
const MAX_RUN_SECONDS = 85; // di bawah batas ~100 dtk proxy Cloudflare
const MAX_TIMEOUT_MINUTES = 60; // batas sesi paket Hobby E2B
const DEFAULT_TIMEOUT_MINUTES = 30;

const INSTRUCTIONS = [
  "Cloud E2B sandboxes managed through an MCP-compatible Worker.",
  "Alur: create → run / write_file / read_file → kill.",
  "Templates: 'node-postgres' (Node 22.21.1 with PostgreSQL 16; use DATABASE_URL_POSTGRES for the sandbox database and POSTGRES_ADMIN_URL or CI_POSTGRES_ADMIN_URL for the admin database), 'docker-supabase' (Node 22.21.1 with a local Supabase stack), or 'base' for general tasks.",
  "sandbox_id berawalan akun (contoh 'a:abc123'); selalu pakai ID persis seperti yang dikembalikan.",
  `Perintah foreground dibatasi ${MAX_RUN_SECONDS} detik. Untuk install/build/test panjang, pakai run dengan background=true lalu pantau log-nya.`,
  `Sandbox hidup maksimal ${MAX_TIMEOUT_MINUTES} menit; perpanjang dengan extend, dan panggil kill setelah selesai.`,
].join(" ");

// ---------- util ----------
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

function safeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++)
    diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

function authorized(request, env) {
  const expected = env.MCP_TOKEN || env.PROBE_TOKEN;
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  return Boolean(expected) && safeEqual(token, expected);
}

const clip = (s) =>
  typeof s === "string" && s.length > MAX_OUTPUT
    ? `${s.slice(0, MAX_OUTPUT)}\n…[dipotong, total ${s.length} karakter]`
    : (s ?? "");

const clamp = (n, lo, hi, def) =>
  Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : def;

function accounts(env) {
  return [
    { id: "a", key: env.E2B_API_KEY_A },
    { id: "b", key: env.E2B_API_KEY_B },
  ].filter((a) => a.key);
}

function keyFor(env, account) {
  const acc = accounts(env).find((a) => a.id === account);
  if (!acc) throw new ToolError(`Akun '${account}' tidak dikonfigurasi.`);
  return acc.key;
}

function parseId(sandboxId) {
  const m = /^([ab]):(.+)$/.exec(String(sandboxId ?? ""));
  if (!m)
    throw new ToolError(
      "sandbox_id harus berformat '<akun>:<id>', contoh 'a:abc123' (pakai ID dari create atau list).",
    );
  return { account: m[1], id: m[2] };
}

function isQuotaError(err) {
  if (err instanceof RateLimitError) return true;
  return /rate limit|limit reached|quota|credit|concurren|billing|payment|\b402\b|\b429\b/i.test(
    String(err?.message ?? err),
  );
}

class ToolError extends Error {}

async function connect(env, sandboxId) {
  const { account, id } = parseId(sandboxId);
  return Sandbox.connect(id, { apiKey: keyFor(env, account) });
}

// ---------- tools ----------
const TOOLS = [
  {
    name: "create",
    description:
      "Buat sandbox E2B baru (Linux). Mengembalikan sandbox_id berawalan akun. Akun 'auto' memakai akun A, lalu pindah ke B bila A kena limit/kredit habis.",
    inputSchema: {
      type: "object",
      properties: {
        template: {
          type: "string",
          description:
            "E2B template: 'node-postgres', 'docker-supabase', or the built-in 'base' template.",
        },
        timeout_minutes: {
          type: "integer",
          minimum: 1,
          maximum: MAX_TIMEOUT_MINUTES,
          description: `Umur sandbox, bawaan ${DEFAULT_TIMEOUT_MINUTES}.`,
        },
        account: {
          type: "string",
          enum: ["auto", "a", "b"],
          description: "Bawaan 'auto'.",
        },
        envs: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Variabel lingkungan untuk sandbox.",
        },
      },
      additionalProperties: false,
    },
    annotations: {
      title: "Buat sandbox",
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "run",
    description: `Jalankan perintah shell (bash) di sandbox. Foreground maksimal ${MAX_RUN_SECONDS} detik. background=true menjalankan di latar dan mengembalikan path log serta file exit code.`,
    inputSchema: {
      type: "object",
      properties: {
        sandbox_id: { type: "string" },
        command: { type: "string" },
        cwd: {
          type: "string",
          description: "Direktori kerja, bawaan /home/user.",
        },
        timeout_seconds: {
          type: "integer",
          minimum: 1,
          maximum: MAX_RUN_SECONDS,
        },
        background: { type: "boolean" },
      },
      required: ["sandbox_id", "command"],
      additionalProperties: false,
    },
    annotations: {
      title: "Jalankan perintah",
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    },
  },
  {
    name: "read_file",
    description: "Baca file teks dari sandbox.",
    inputSchema: {
      type: "object",
      properties: { sandbox_id: { type: "string" }, path: { type: "string" } },
      required: ["sandbox_id", "path"],
      additionalProperties: false,
    },
    annotations: {
      title: "Baca file",
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "write_file",
    description:
      "Tulis (timpa) file teks di sandbox. Direktori induk dibuat otomatis.",
    inputSchema: {
      type: "object",
      properties: {
        sandbox_id: { type: "string" },
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["sandbox_id", "path", "content"],
      additionalProperties: false,
    },
    annotations: {
      title: "Tulis file",
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "list",
    description:
      "Daftar sandbox yang sedang hidup di semua akun yang dikonfigurasi.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: {
      title: "Daftar sandbox",
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "extend",
    description: `Atur ulang sisa umur sandbox (menit dari sekarang, maksimal ${MAX_TIMEOUT_MINUTES}).`,
    inputSchema: {
      type: "object",
      properties: {
        sandbox_id: { type: "string" },
        timeout_minutes: {
          type: "integer",
          minimum: 1,
          maximum: MAX_TIMEOUT_MINUTES,
        },
      },
      required: ["sandbox_id", "timeout_minutes"],
      additionalProperties: false,
    },
    annotations: {
      title: "Perpanjang sandbox",
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "kill",
    description: "Matikan dan hapus sandbox.",
    inputSchema: {
      type: "object",
      properties: { sandbox_id: { type: "string" } },
      required: ["sandbox_id"],
      additionalProperties: false,
    },
    annotations: {
      title: "Hapus sandbox",
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    },
  },
];

const handlers = {
  async create(env, args) {
    const configured = accounts(env);
    if (configured.length === 0)
      throw new ToolError("Belum ada E2B_API_KEY_A/B yang diisi.");
    const wanted = args.account ?? "auto";
    const order =
      wanted === "auto"
        ? configured
        : configured.filter((a) => a.id === wanted);
    if (order.length === 0)
      throw new ToolError(`Akun '${wanted}' tidak dikonfigurasi.`);

    const timeoutMinutes = clamp(
      args.timeout_minutes,
      1,
      MAX_TIMEOUT_MINUTES,
      DEFAULT_TIMEOUT_MINUTES,
    );
    const opts = {
      timeoutMs: timeoutMinutes * 60_000,
      envs: args.envs,
      metadata: { creator: "e2b-mcp" },
    };
    const failures = [];

    for (const acc of order) {
      try {
        const sbx = args.template
          ? await Sandbox.create(args.template, { ...opts, apiKey: acc.key })
          : await Sandbox.create({ ...opts, apiKey: acc.key });
        return {
          sandbox_id: `${acc.id}:${sbx.sandboxId}`,
          account: acc.id,
          template: args.template ?? "base",
          timeout_minutes: timeoutMinutes,
          note: failures.length
            ? `Akun sebelumnya gagal: ${failures.join("; ")}`
            : undefined,
        };
      } catch (err) {
        failures.push(`${acc.id}: ${err?.message ?? err}`);
        if (wanted !== "auto" || !isQuotaError(err)) throw err;
      }
    }
    throw new ToolError(
      `Semua akun gagal membuat sandbox: ${failures.join("; ")}`,
    );
  },

  async run(env, args) {
    const sbx = await connect(env, args.sandbox_id);
    const cwd = args.cwd || "/home/user";

    if (args.background) {
      const job = `job-${Date.now().toString(36)}`;
      const dir = "/tmp/e2b-mcp-jobs";
      await sbx.files.write(
        `${dir}/${job}.sh`,
        `cd ${JSON.stringify(cwd)} || exit 1\n( ${args.command}\n)\necho $? > ${dir}/${job}.exit\n`,
      );
      const r = await sbx.commands.run(
        `setsid nohup bash ${dir}/${job}.sh > ${dir}/${job}.log 2>&1 < /dev/null & echo $!`,
        { timeoutMs: 15_000 },
      );
      return {
        background: true,
        job,
        pid: Number(r.stdout.trim()),
        log: `${dir}/${job}.log`,
        exit_code_file: `${dir}/${job}.exit`,
        hint: `Pantau dengan run: tail -n 50 ${dir}/${job}.log ; selesai bila file ${dir}/${job}.exit ada (isinya exit code).`,
      };
    }

    const timeoutMs =
      clamp(args.timeout_seconds, 1, MAX_RUN_SECONDS, 60) * 1000;
    try {
      const r = await sbx.commands.run(args.command, { cwd, timeoutMs });
      return {
        exit_code: r.exitCode,
        stdout: clip(r.stdout),
        stderr: clip(r.stderr),
      };
    } catch (err) {
      if (err instanceof CommandExitError) {
        return {
          exit_code: err.exitCode,
          stdout: clip(err.stdout),
          stderr: clip(err.stderr),
        };
      }
      throw err;
    }
  },

  async read_file(env, args) {
    const sbx = await connect(env, args.sandbox_id);
    const content = await sbx.files.read(args.path);
    return { path: args.path, content: clip(content) };
  },

  async write_file(env, args) {
    const sbx = await connect(env, args.sandbox_id);
    await sbx.files.write(args.path, args.content);
    return {
      path: args.path,
      bytes: new TextEncoder().encode(args.content).length,
    };
  },

  async list(env) {
    const out = [];
    for (const acc of accounts(env)) {
      try {
        const items = await Sandbox.list({ apiKey: acc.key }).nextItems();
        for (const s of items) {
          out.push({
            sandbox_id: `${acc.id}:${s.sandboxId}`,
            template: s.name || s.templateId,
            state: s.state,
            started_at: s.startedAt,
            ends_at: s.endAt,
            created_by_mcp: s.metadata?.creator === "e2b-mcp",
          });
        }
      } catch (err) {
        out.push({ account: acc.id, error: String(err?.message ?? err) });
      }
    }
    return { sandboxes: out };
  },

  async extend(env, args) {
    const { account, id } = parseId(args.sandbox_id);
    const minutes = clamp(
      args.timeout_minutes,
      1,
      MAX_TIMEOUT_MINUTES,
      DEFAULT_TIMEOUT_MINUTES,
    );
    await Sandbox.setTimeout(id, minutes * 60_000, {
      apiKey: keyFor(env, account),
    });
    return { sandbox_id: args.sandbox_id, timeout_minutes_from_now: minutes };
  },

  async kill(env, args) {
    const { account, id } = parseId(args.sandbox_id);
    const killed = await Sandbox.kill(id, { apiKey: keyFor(env, account) });
    return { sandbox_id: args.sandbox_id, killed };
  },
};

async function callTool(env, name, args) {
  const handler = handlers[name];
  if (!handler)
    return {
      content: [{ type: "text", text: `Tool tidak dikenal: ${name}` }],
      isError: true,
    };
  try {
    const result = await handler(env, args ?? {});
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
    };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Gagal: ${err?.message ?? err}` }],
      isError: true,
    };
  }
}

// ---------- JSON-RPC / MCP ----------
const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id, code, message) => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});

async function handleMessage(env, msg) {
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return rpcError(msg?.id ?? null, -32600, "Invalid Request");
  }
  const isNotification = msg.id === undefined;
  if (isNotification) return null;

  switch (msg.method) {
    case "initialize": {
      const requested = msg.params?.protocolVersion;
      return rpcResult(msg.id, {
        protocolVersion: PROTOCOLS.includes(requested)
          ? requested
          : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return rpcResult(msg.id, {});
    case "tools/list":
      return rpcResult(msg.id, { tools: TOOLS });
    case "tools/call":
      return rpcResult(
        msg.id,
        await callTool(env, msg.params?.name, msg.params?.arguments),
      );
    default:
      return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

async function handleMcp(request, env) {
  if (request.method !== "POST")
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { allow: "POST" },
    });

  let body;
  try {
    body = await request.json();
  } catch {
    return json(rpcError(null, -32700, "Parse error"), 400);
  }

  const batch = Array.isArray(body);
  request.__rpcMethods = (batch ? body : [body]).map((m) => m?.method);
  const responses = (
    await Promise.all((batch ? body : [body]).map((m) => handleMessage(env, m)))
  ).filter(Boolean);
  if (responses.length === 0) return new Response(null, { status: 202 });
  return json(batch ? responses : responses[0]);
}

// ---------- probe (diagnostik) ----------
async function probe(env, account) {
  const steps = [];
  const t0 = Date.now();
  const mark = (step, extra = {}) =>
    steps.push({ step, ms: Date.now() - t0, ...extra });
  let sbx;
  let ok = false;
  try {
    sbx = await Sandbox.create({
      apiKey: keyFor(env, account),
      timeoutMs: 120_000,
    });
    mark("create", { sandboxId: sbx.sandboxId });
    const r = await sbx.commands.run("echo ok && uname -a", {
      timeoutMs: 30_000,
    });
    mark("command", { exitCode: r.exitCode, stdout: r.stdout });
    const content = `probe ${new Date().toISOString()}`;
    await sbx.files.write("/tmp/probe.txt", content);
    mark("file", {
      match: (await sbx.files.read("/tmp/probe.txt")) === content,
    });
    ok = true;
  } catch (err) {
    mark("error", { message: String(err?.message ?? err) });
  }
  if (sbx) {
    try {
      mark("kill", { killed: await sbx.kill() });
    } catch (err) {
      mark("kill-failed", { message: String(err?.message ?? err) });
    }
  }
  return json({ ok, account, steps }, ok ? 200 : 500);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const started = Date.now();
    const response = await route(request, env, url);
    // Log diagnostik ringkas (tanpa header Authorization / isi body). Lihat dengan `npx wrangler tail`.
    console.log(
      JSON.stringify({
        path: url.pathname,
        method: request.method,
        status: response.status,
        ms: Date.now() - started,
        accept: request.headers.get("accept"),
        mcpProtocolVersion: request.headers.get("mcp-protocol-version"),
        rpc: request.__rpcMethods,
        ua: request.headers.get("user-agent"),
      }),
    );
    return response;
  },
};

async function route(request, env, url) {
  if (url.pathname === "/health") return new Response("ok");
  // Server ini tidak memakai OAuth: discovery OAuth dijawab 404 tanpa auth.
  if (url.pathname.startsWith("/.well-known/"))
    return json({ error: "not found" }, 404);
  if (!authorized(request, env)) return json({ error: "unauthorized" }, 401);
  if (url.pathname === "/mcp" || url.pathname === "/mcp/")
    return handleMcp(request, env);
  if (url.pathname === "/probe" && request.method === "POST") {
    const account = (url.searchParams.get("account") ?? "a").toLowerCase();
    if (!["a", "b"].includes(account))
      return json({ error: "account harus a atau b" }, 400);
    return probe(env, account);
  }
  return json({ error: "not found" }, 404);
}
