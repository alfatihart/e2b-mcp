// Definisi template E2B. Dibangun dengan: node templates/build.mjs v1|v2|all
import { Template, waitForPort, waitForFile } from "e2b";

const NODE_VERSION = "22.21.1";
const NPM_VERSION = "10.9.4";
const SUPABASE_CLI_VERSION = "2.120.0";
const SUPABASE_PG_VERSION = process.env.SUPABASE_PG_VERSION || "15.8.1.085";

// Paket dasar + Node persis + gh, dipakai kedua template.
function base() {
  return Template()
    .fromUbuntuImage("24.04")
    .aptInstall([
      "curl",
      "ca-certificates",
      "gnupg",
      "git",
      "jq",
      "unzip",
      "xz-utils",
      "build-essential",
      "python3",
    ])
    .runCmd(
      [
        `curl -fsSL https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz | tar -xJ -C /usr/local --strip-components=1`,
        `npm install -g npm@${NPM_VERSION}`,
        "install -d -m 0755 /etc/apt/keyrings",
        "curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg",
        'echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list',
        "apt-get update && apt-get install -y gh",
        "node --version && npm --version && gh --version | head -1",
      ],
      { user: "root" },
    );
}

// V2: PostgreSQL 16 native di 127.0.0.1:5432.
export const v2 = base()
  .aptInstall(["postgresql-16", "postgresql-client-16"])
  .runCmd(
    [
      "systemctl mask postgresql.service postgresql@16-main.service || true",
      "systemctl stop postgresql@16-main.service postgresql.service 2>/dev/null || true",
      "pkill -u postgres -x postgres || true",
      "for i in $(seq 1 30); do pgrep -u postgres -x postgres >/dev/null || break; sleep 1; done",
      "install -d -o postgres -g postgres -m 2775 /var/run/postgresql",
      "sed -i 's/^ssl = on/ssl = off/' /etc/postgresql/16/main/postgresql.conf",
      "rm -f /var/lib/postgresql/16/main/postmaster.pid",
      "pg_ctlcluster --skip-systemctl-redirect 16 main start",
      `su postgres -c "psql -v ON_ERROR_STOP=1 -c \\"CREATE ROLE dev LOGIN SUPERUSER PASSWORD 'dev'\\""`,
      'su postgres -c "createdb -O dev sandbox"',
      "pg_ctlcluster --skip-systemctl-redirect 16 main stop",
    ],
    { user: "root" },
  )
  .setEnvs({
    DATABASE_URL_POSTGRES: "postgresql://dev:dev@127.0.0.1:5432/sandbox",
    POSTGRES_ADMIN_URL: "postgresql://dev:dev@127.0.0.1:5432/postgres",
    CI_POSTGRES_ADMIN_URL: "postgresql://dev:dev@127.0.0.1:5432/postgres",
  })
  .setStartCmd(
    "sudo install -d -o postgres -g postgres -m 2775 /var/run/postgresql && sudo -u postgres /usr/lib/postgresql/16/bin/postgres -D /var/lib/postgresql/16/main -c config_file=/etc/postgresql/16/main/postgresql.conf -c listen_addresses=127.0.0.1",
    waitForPort(5432),
  );

// V1 (Supabase): Docker + Supabase CLI, stack minimal (db, auth, storage, rest, kong) sudah berjalan
// saat sandbox dibuat, karena E2B menyimpan snapshot setelah start command siap.
const SUPABASE_DIR = "/home/user/sandbox-supabase";
const SUPABASE_EXCLUDE =
  "realtime,imgproxy,mailpit,postgres-meta,studio,edge-runtime,logflare,vector,supavisor";

const START_SUPABASE = [
  "set -euo pipefail",
  'echo "[start] menyalakan Docker"',
  "if ! sudo docker info >/dev/null 2>&1; then",
  "  sudo systemctl start docker 2>&1 || { echo '[start] systemctl gagal, pakai dockerd manual'; sudo dockerd > /tmp/dockerd.log 2>&1 & }",
  "fi",
  "for i in $(seq 1 90); do sudo docker info >/dev/null 2>&1 && break; sleep 1; done",
  "sudo docker info >/dev/null 2>&1 || { echo '[start] Docker tidak siap'; sudo tail -n 50 /tmp/dockerd.log 2>/dev/null || true; exit 1; }",
  'echo "[start] jumlah dockerd: $(pgrep -c -x dockerd || true)"',
  "sudo chmod 666 /var/run/docker.sock",
  `cd ${SUPABASE_DIR}`,
  'echo "[start] supabase start"',
  `supabase start -x ${SUPABASE_EXCLUDE}`,
  `supabase status -o env > ${SUPABASE_DIR}/status.env`,
  'echo "[start] Supabase siap"',
  "touch /tmp/sandbox-supabase-ready",
  "sleep infinity",
].join("\n");

export const v1 = base()
  .aptInstall(["postgresql-client"])
  .runCmd(
    [
      "curl -fsSL https://get.docker.com | sh",
      "usermod -aG docker user",
      "(systemctl start docker 2>&1 || (dockerd > /tmp/dockerd-build.log 2>&1 &))",
      "for i in $(seq 1 90); do docker info >/dev/null 2>&1 && break; sleep 1; done",
      "docker run --rm hello-world",
      `curl -fsSL https://github.com/supabase/cli/releases/download/v${SUPABASE_CLI_VERSION}/supabase_linux_amd64.tar.gz | tar -xz -C /usr/local/bin supabase`,
      "supabase --version",
    ],
    { user: "root" },
  )
  .runCmd([
    "mkdir -p /home/user/sandbox-supabase && cd /home/user/sandbox-supabase && supabase init",
    "cd /home/user/sandbox-supabase && sed -i 's/^major_version = .*/major_version = 15/; s/^project_id = .*/project_id = \"sandbox-local\"/' supabase/config.toml",
    `mkdir -p /home/user/sandbox-supabase/supabase/.temp && echo "${SUPABASE_PG_VERSION}" > /home/user/sandbox-supabase/supabase/.temp/postgres-version`,
    `echo ${Buffer.from(START_SUPABASE + "\n").toString("base64")} | base64 -d > /home/user/start-supabase.sh && chmod +x /home/user/start-supabase.sh`,
  ])
  .setEnvs({
    DATABASE_URL_SUPABASE:
      "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
    SUPABASE_URL: "http://127.0.0.1:54321",
    SUPABASE_STATUS_ENV: `${SUPABASE_DIR}/status.env`,
  })
  .setStartCmd(
    "bash -c 'set -o pipefail; bash /home/user/start-supabase.sh 2>&1 | tee /tmp/start-supabase.log'",
    waitForFile("/tmp/sandbox-supabase-ready"),
  );
