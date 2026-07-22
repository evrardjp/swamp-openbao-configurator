import { z } from "npm:zod@4";

type JsonObject = Record<string, unknown>;

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const GlobalArgsSchema = z.object({
  apiAddr: z.string().url().describe(
    "OpenBao API address, for example https://bao.example.com:8200",
  ),
});

const InitializeArgsSchema = z.object({
  vaultName: z.string().default("openbao-creds").describe(
    "Swamp vault where unseal keys and root token will be stored",
  ),
  keyShares: z.number().int().positive().default(5).describe(
    "Total number of unseal key shares to generate",
  ),
  keyThreshold: z.number().int().positive().default(3).describe(
    "Minimum number of key shares required to unseal",
  ),
});

const UnsealArgsSchema = z.object({
  unsealKey: z.string().meta({ sensitive: true }).describe(
    "One unseal key share; prefer a vault expression such as vault.get(...) in workflow inputs",
  ),
});

const SealArgsSchema = z.object({
  token: z.string().meta({ sensitive: true }).describe(
    "Root or operator token; prefer a vault expression such as vault.get(...) in workflow inputs",
  ),
});

const StatusStateSchema = z.object({
  apiAddr: z.string(),
  initialized: z.boolean().optional(),
  sealed: z.boolean().optional(),
  standby: z.boolean().optional(),
  performanceStandby: z.boolean().optional(),
  serverTimeUtc: z.number().optional(),
  version: z.string().optional(),
  clusterName: z.string().optional(),
  clusterId: z.string().optional(),
  checkedAt: z.string(),
  httpStatus: z.number(),
});

const InitializedStateSchema = z.object({
  apiAddr: z.string(),
  vaultName: z.string(),
  keyShares: z.number(),
  keyThreshold: z.number(),
  initializedAt: z.string().optional(),
  skippedAt: z.string().optional(),
  skipped: z.boolean().optional(),
});

const UnsealStateSchema = z.object({
  apiAddr: z.string(),
  progress: z.number(),
  threshold: z.number(),
  sealed: z.boolean(),
  unsealedAt: z.string().optional(),
});

const SealStateSchema = z.object({
  apiAddr: z.string(),
  sealedAt: z.string(),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;
type InitializeArgs = z.infer<typeof InitializeArgsSchema>;
type UnsealArgs = z.infer<typeof UnsealArgsSchema>;
type SealArgs = z.infer<typeof SealArgsSchema>;

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
  putSecret?: (vaultName: string, key: string, value: string) => Promise<void>;
  fetch?: FetchLike;
}

function apiUrl(apiAddr: string, path: string): string {
  return `${apiAddr.replace(/\/+$/, "")}/v1/${path.replace(/^\/+/, "")}`;
}

async function readJson(response: Response): Promise<JsonObject> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(
      `OpenBao returned non-JSON response: ${error}; body=${
        text.slice(0, 300)
      }`,
    );
  }
}

async function requestJson(
  context: MethodContext,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: JsonObject }> {
  const fetcher = context.fetch ?? fetch;
  const response = await fetcher(apiUrl(context.globalArgs.apiAddr, path), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const body = await readJson(response);
  if (!response.ok) {
    throw new Error(
      `OpenBao ${path} failed with HTTP ${response.status}: ${
        JSON.stringify(body).slice(0, 500)
      }`,
    );
  }
  return { status: response.status, body };
}

async function putSecret(
  context: MethodContext,
  vaultName: string,
  key: string,
  value: string,
): Promise<void> {
  if (!context.putSecret) {
    throw new Error(
      "This Swamp runtime does not expose context.putSecret; cannot store OpenBao secrets safely",
    );
  }
  await context.putSecret(vaultName, key, value);
}

function healthResource(
  apiAddr: string,
  status: number,
  body: JsonObject,
): Record<string, unknown> {
  return {
    apiAddr,
    initialized: body.initialized as boolean | undefined,
    sealed: body.sealed as boolean | undefined,
    standby: body.standby as boolean | undefined,
    performanceStandby: body.performance_standby as boolean | undefined,
    serverTimeUtc: body.server_time_utc as number | undefined,
    version: body.version as string | undefined,
    clusterName: body.cluster_name as string | undefined,
    clusterId: body.cluster_id as string | undefined,
    checkedAt: new Date().toISOString(),
    httpStatus: status,
  };
}

async function status(
  context: MethodContext,
): Promise<Record<string, unknown>> {
  const fetcher = context.fetch ?? fetch;
  const response = await fetcher(
    apiUrl(
      context.globalArgs.apiAddr,
      "sys/health?standbyok=true&sealedcode=200&uninitcode=200",
    ),
  );
  const body = await readJson(response);
  return healthResource(context.globalArgs.apiAddr, response.status, body);
}

/** Swamp model for OpenBao API lifecycle control. Deployment is handled by cfgmgmt models. */
export const model = {
  type: "@evrardjp/openbao-configurator",
  version: "2026.07.03.2",
  globalArguments: GlobalArgsSchema,
  resources: {
    status: {
      description: "OpenBao health/status snapshot from the API",
      schema: StatusStateSchema,
      lifetime: "7d",
      garbageCollection: 20,
    },
    initState: {
      description:
        "OpenBao initialization state; generated keys are stored in the Swamp vault",
      schema: InitializedStateSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    unseal: {
      description: "Unseal progress after submitting one key share",
      schema: UnsealStateSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    seal: {
      description: "Seal confirmation",
      schema: SealStateSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  files: {
    log: {
      description: "OpenBao lifecycle operation log",
      contentType: "text/plain",
      lifetime: "7d",
      garbageCollection: 5,
      streaming: true,
    },
  },
  methods: {
    status: {
      description: "Read OpenBao health/status from the API",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: MethodContext) => {
        const snapshot = await status(context);
        const handle = await context.writeResource(
          "status",
          "current",
          snapshot,
        );
        return { dataHandles: [handle] };
      },
    },

    initialize: {
      description:
        "Initialize OpenBao through the API, then store unseal keys and root token in a Swamp vault",
      arguments: InitializeArgsSchema,
      execute: async (args: InitializeArgs, context: MethodContext) => {
        const logWriter = context.createFileWriter("log", "initialize", {
          streaming: true,
        });
        const log = async (msg: string) => {
          context.logger.info(msg);
          await logWriter.writeLine(msg);
        };

        await log(
          `Checking OpenBao initialization state at ${context.globalArgs.apiAddr}`,
        );
        const initStatus = await requestJson(context, "sys/init");
        if (initStatus.body.initialized === true) {
          await log("OpenBao is already initialized; skipping init");
          const skipHandle = await context.writeResource(
            "initState",
            "result",
            {
              apiAddr: context.globalArgs.apiAddr,
              vaultName: args.vaultName,
              keyShares: args.keyShares,
              keyThreshold: args.keyThreshold,
              skipped: true,
              skippedAt: new Date().toISOString(),
            },
          );
          const logHandle = await logWriter.finalize();
          return { dataHandles: [skipHandle, logHandle] };
        }

        await log(
          `Initializing OpenBao with ${args.keyShares} shares and threshold ${args.keyThreshold}`,
        );
        const init = await requestJson(context, "sys/init", {
          method: "PUT",
          body: JSON.stringify({
            secret_shares: args.keyShares,
            secret_threshold: args.keyThreshold,
          }),
        });
        const unsealKeys = (init.body.keys_base64 ??
          init.body.unseal_keys_b64 ?? init.body.keys) as string[] | undefined;
        const rootToken = init.body.root_token as string | undefined;
        if (
          !Array.isArray(unsealKeys) || unsealKeys.length === 0 || !rootToken
        ) {
          throw new Error(
            "OpenBao init response did not contain unseal keys and root token",
          );
        }

        await log(
          `Storing ${unsealKeys.length} unseal keys in vault ${args.vaultName}`,
        );
        for (let i = 0; i < unsealKeys.length; i++) {
          const secretName = `OPENBAO_UNSEAL_KEY_${i + 1}`;
          await putSecret(context, args.vaultName, secretName, unsealKeys[i]);
          await log(`Stored ${secretName}`);
        }
        await putSecret(
          context,
          args.vaultName,
          "OPENBAO_ROOT_TOKEN",
          rootToken,
        );
        await log("Stored OPENBAO_ROOT_TOKEN");

        const initHandle = await context.writeResource("initState", "result", {
          apiAddr: context.globalArgs.apiAddr,
          vaultName: args.vaultName,
          keyShares: args.keyShares,
          keyThreshold: args.keyThreshold,
          initializedAt: new Date().toISOString(),
        });
        const logHandle = await logWriter.finalize();
        return { dataHandles: [initHandle, logHandle] };
      },
    },

    unseal: {
      description: "Submit one unseal key share through the OpenBao API",
      arguments: UnsealArgsSchema,
      execute: async (args: UnsealArgs, context: MethodContext) => {
        context.logger.info(
          `Submitting one unseal key share to ${context.globalArgs.apiAddr}`,
        );
        const unseal = await requestJson(context, "sys/unseal", {
          method: "PUT",
          body: JSON.stringify({ key: args.unsealKey }),
        });
        const progress = unseal.body.progress as number;
        const threshold = unseal.body.t as number;
        const sealed = unseal.body.sealed as boolean;
        const handle = await context.writeResource("unseal", "result", {
          apiAddr: context.globalArgs.apiAddr,
          progress,
          threshold,
          sealed,
          unsealedAt: !sealed ? new Date().toISOString() : undefined,
        });
        return { dataHandles: [handle] };
      },
    },

    seal: {
      description: "Seal OpenBao through the API using an operator token",
      arguments: SealArgsSchema,
      execute: async (args: SealArgs, context: MethodContext) => {
        context.logger.info(`Sealing OpenBao at ${context.globalArgs.apiAddr}`);
        await requestJson(context, "sys/seal", {
          method: "PUT",
          headers: { "x-vault-token": args.token },
          body: JSON.stringify({}),
        });
        const handle = await context.writeResource("seal", "result", {
          apiAddr: context.globalArgs.apiAddr,
          sealedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
