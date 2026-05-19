import { z } from "npm:zod@4";

// deno-lint-ignore-file no-explicit-any
/* eslint-disable @typescript-eslint/no-explicit-any */

// @ts-ignore: Deno global available at bundle runtime
const DenoCmd = Deno.Command;
// @ts-ignore: Deno global available at bundle runtime
const DenoFs = { writeTextFile: Deno.writeTextFile, remove: Deno.remove };

async function sshRaw(
  host: string,
  user: string,
  keyPath: string,
  command: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = new DenoCmd("ssh", {
    args: [
      "-o",
      "StrictHostKeyChecking=no",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "BatchMode=yes",
      "-i",
      keyPath,
      `${user}@${host}`,
      command,
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const result = await proc.output();
  return {
    code: result.code,
    stdout: new TextDecoder().decode(result.stdout).trim(),
    stderr: new TextDecoder().decode(result.stderr).trim(),
  };
}

async function sshOrThrow(
  host: string,
  user: string,
  keyPath: string,
  command: string,
): Promise<string> {
  const r = await sshRaw(host, user, keyPath, command);
  if (r.code !== 0) {
    throw new Error(
      `SSH command failed on ${host} (exit ${r.code}): ${r.stderr.slice(-500)}`,
    );
  }
  return r.stdout;
}

async function scpOrThrow(
  localPath: string,
  host: string,
  user: string,
  keyPath: string,
  remotePath: string,
): Promise<void> {
  const proc = new DenoCmd("scp", {
    args: [
      "-o",
      "StrictHostKeyChecking=no",
      "-i",
      keyPath,
      localPath,
      `${user}@${host}:${remotePath}`,
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const result = await proc.output();
  if (result.code !== 0) {
    throw new Error(
      `SCP to ${host}:${remotePath} failed (exit ${result.code}): ${
        new TextDecoder().decode(result.stderr).slice(-500)
      }`,
    );
  }
}

const GlobalArgsSchema = z.object({
  host: z.string().describe("SSH host IP or hostname"),
  sshUser: z.string().default("admin").describe("SSH user"),
  sshKeyPath: z.string().default("~/.ssh/id_ed25519").describe(
    "Path to SSH private key",
  ),
});

const RaftStorageSchema = z.object({
  path: z.string().default("/var/lib/openbao/data").describe(
    "Raft storage data directory",
  ),
  nodeId: z.string().default("vault-node-1").describe("Raft node identifier"),
});

const TcpListenerSchema = z.object({
  address: z.string().describe("Listener address in host:port format"),
  tlsDisable: z.boolean().default(false).describe(
    "Disable TLS on this listener",
  ),
  tlsCertFile: z.string().default("/etc/openbao/tls/openbao.crt").describe(
    "Path to TLS certificate file",
  ),
  tlsKeyFile: z.string().default("/etc/openbao/tls/openbao.key").describe(
    "Path to TLS private key file",
  ),
});

const DeployArgsSchema = z.object({
  ui: z.boolean().default(false).describe("Enable the OpenBao web UI"),
  storage: RaftStorageSchema.default({}),
  listener: TcpListenerSchema,
  clusterAddr: z.string().describe(
    "Cluster advertise address (e.g., https://192.168.164.10:8201)",
  ),
  apiAddr: z.string().describe(
    "API advertise address (e.g., https://192.168.164.10:8200)",
  ),
  configPath: z.string().default("/etc/openbao/openbao.hcl").describe(
    "Remote path for the deployed HCL config file",
  ),
});

const DeployedConfigSchema = z.object({
  host: z.string(),
  configPath: z.string(),
  ui: z.boolean(),
  storageBackend: z.literal("raft"),
  storagePath: z.string(),
  storageNodeId: z.string(),
  listenerAddress: z.string(),
  tlsEnabled: z.boolean(),
  clusterAddr: z.string(),
  apiAddr: z.string(),
  serviceActive: z.boolean(),
  deployedAt: z.string(),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;
type DeployArgs = z.infer<typeof DeployArgsSchema>;

interface Logger {
  info(msg: string, props?: Record<string, unknown>): void;
  debug(msg: string, props?: Record<string, unknown>): void;
  warning(msg: string, props?: Record<string, unknown>): void;
  error(msg: string, props?: Record<string, unknown>): void;
}

interface FileWriter {
  writeLine(line: string): Promise<void>;
  finalize(): Promise<unknown>;
}

interface MethodContext {
  globalArgs: GlobalArgs;
  logger: Logger;
  writeResource(
    specName: string,
    instanceName: string,
    data: Record<string, unknown>,
  ): Promise<unknown>;
  createFileWriter(
    specName: string,
    instanceName: string,
    opts?: { streaming?: boolean },
  ): FileWriter;
}

interface CheckContext {
  globalArgs: GlobalArgs;
  logger: Logger;
}

function renderHcl(args: DeployArgs): string {
  const tlsSection = args.listener.tlsDisable
    ? `  tls_disable = true`
    : `  tls_cert_file = "${args.listener.tlsCertFile}"\n  tls_key_file  = "${args.listener.tlsKeyFile}"`;

  return `ui = ${args.ui}

storage "raft" {
  path    = "${args.storage.path}"
  node_id = "${args.storage.nodeId}"
}

listener "tcp" {
  address = "${args.listener.address}"
${tlsSection}
}

cluster_addr = "${args.clusterAddr}"
api_addr     = "${args.apiAddr}"
`;
}

/** Swamp model that renders and deploys an OpenBao HCL config over SSH, then restarts the service. */
export const model = {
  type: "@evrardjp/openbao-configurator",
  version: "2026.05.19.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    config: {
      description: "Deployed OpenBao configuration state",
      schema: DeployedConfigSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  files: {
    log: {
      description: "Deployment log",
      contentType: "text/plain",
      lifetime: "7d",
      garbageCollection: 5,
      streaming: true,
    },
  },
  checks: {
    "ssh-reachable": {
      description:
        "Verify SSH connectivity to the target host before deploying",
      labels: ["live"],
      execute: async (
        context: CheckContext,
      ): Promise<{ pass: boolean; errors?: string[] }> => {
        const { host, sshUser, sshKeyPath } = context.globalArgs;
        const r = await sshRaw(host, sshUser, sshKeyPath, "true");
        if (r.code !== 0) {
          return {
            pass: false,
            errors: [`Cannot reach ${sshUser}@${host} via SSH: ${r.stderr}`],
          };
        }
        return { pass: true };
      },
    },
  },
  methods: {
    deploy: {
      description:
        "Render and deploy the OpenBao HCL configuration, then restart the service",
      arguments: DeployArgsSchema,
      execute: async (
        args: DeployArgs,
        context: MethodContext,
      ): Promise<{ dataHandles: unknown[] }> => {
        const { host, sshUser, sshKeyPath } = context.globalArgs;
        const logWriter = context.createFileWriter("log", "deploy", {
          streaming: true,
        });

        const log = async (msg: string): Promise<void> => {
          context.logger.info(msg);
          await logWriter.writeLine(msg);
        };

        await log(`Deploying OpenBao config to ${host} (ui=${args.ui})`);

        const hcl = renderHcl(args);
        const tmpPath = `/tmp/openbao-${Date.now()}.hcl`;
        await DenoFs.writeTextFile(tmpPath, hcl);

        try {
          await sshOrThrow(
            host,
            sshUser,
            sshKeyPath,
            "sudo mkdir -p /etc/openbao && sudo chown openbao:openbao /etc/openbao",
          );

          await scpOrThrow(
            tmpPath,
            host,
            sshUser,
            sshKeyPath,
            "/tmp/openbao-new.hcl",
          );

          await sshOrThrow(
            host,
            sshUser,
            sshKeyPath,
            `sudo cp /tmp/openbao-new.hcl ${args.configPath} && sudo chown openbao:openbao ${args.configPath} && sudo chmod 640 ${args.configPath}`,
          );
          await log(`Config deployed to ${args.configPath}`);

          await sshOrThrow(
            host,
            sshUser,
            sshKeyPath,
            `sudo mkdir -p ${args.storage.path} && sudo chown -R openbao:openbao ${args.storage.path}`,
          );
          await log(`Storage directory ${args.storage.path} ready`);

          await log("Restarting openbao service...");
          await sshOrThrow(
            host,
            sshUser,
            sshKeyPath,
            "sudo systemctl restart openbao",
          );

          await new Promise<void>((resolve) => setTimeout(resolve, 5000));

          const activeResult = await sshRaw(
            host,
            sshUser,
            sshKeyPath,
            "sudo systemctl is-active openbao",
          );
          const serviceActive = activeResult.code === 0 &&
            activeResult.stdout === "active";

          if (!serviceActive) {
            const journal = await sshRaw(
              host,
              sshUser,
              sshKeyPath,
              "sudo journalctl -u openbao -n 30 --no-pager",
            );
            await log(`ERROR: openbao failed to start\n${journal.stdout}`);
            throw new Error(
              `OpenBao service is not active after config deploy on ${host}. Last logs: ${
                journal.stdout.slice(-800)
              }`,
            );
          }
          await log("OpenBao service active");

          const configHandle = await context.writeResource(
            "config",
            "current",
            {
              host,
              configPath: args.configPath,
              ui: args.ui,
              storageBackend: "raft",
              storagePath: args.storage.path,
              storageNodeId: args.storage.nodeId,
              listenerAddress: args.listener.address,
              tlsEnabled: !args.listener.tlsDisable,
              clusterAddr: args.clusterAddr,
              apiAddr: args.apiAddr,
              serviceActive,
              deployedAt: new Date().toISOString(),
            },
          );

          const logHandle = await logWriter.finalize();
          return { dataHandles: [configHandle, logHandle] };
        } finally {
          await DenoFs.remove(tmpPath).catch(() => {});
        }
      },
    },
  },
};
