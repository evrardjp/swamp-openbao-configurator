import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { model } from "./openbao.ts";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function context(routes: Record<string, (init?: RequestInit) => Response>) {
  const writes: Array<{ specName: string; instanceName: string; data: Record<string, unknown> }> = [];
  const secrets = new Map<string, string>();
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  return {
    writes,
    secrets,
    requests,
    ctx: {
      globalArgs: { apiAddr: "https://bao.example.test:8200" },
      logger: { info() {}, debug() {}, warning() {}, error() {} },
      writeResource: async (specName: string, instanceName: string, data: Record<string, unknown>) => {
        writes.push({ specName, instanceName, data });
        return { specName, instanceName };
      },
      createFileWriter: () => ({
        writeLine: async () => {},
        finalize: async () => ({ specName: "log", instanceName: "test" }),
      }),
      putSecret: async (vaultName: string, key: string, value: string) => {
        secrets.set(`${vaultName}/${key}`, value);
      },
      fetch: async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        requests.push({ url, init });
        const path = new URL(url).pathname;
        const route = routes[path];
        if (!route) return json({ errors: [`missing route ${path}`] }, 404);
        return route(init);
      },
    },
  };
}

Deno.test("status records OpenBao health without SSH", async () => {
  const h = context({
    "/v1/sys/health": () => json({ initialized: true, sealed: false, version: "2.2.0" }),
  });

  await model.methods.status.execute({}, h.ctx);

  assertEquals(h.requests[0].url, "https://bao.example.test:8200/v1/sys/health?standbyok=true&sealedcode=200&uninitcode=200");
  assertEquals(h.writes[0].specName, "status");
  assertEquals(h.writes[0].data.initialized, true);
  assertEquals(h.writes[0].data.sealed, false);
});

Deno.test("initialize stores unseal keys and root token in vault", async () => {
  const h = context({
    "/v1/sys/init": (init?: RequestInit) => {
      if (init?.method === "PUT") {
        return json({ keys_base64: ["k1", "k2", "k3"], root_token: "root" });
      }
      return json({ initialized: false });
    },
  });

  await model.methods.initialize.execute({ vaultName: "local", keyShares: 3, keyThreshold: 2 }, h.ctx);

  assertEquals(h.secrets.get("local/OPENBAO_UNSEAL_KEY_1"), "k1");
  assertEquals(h.secrets.get("local/OPENBAO_UNSEAL_KEY_3"), "k3");
  assertEquals(h.secrets.get("local/OPENBAO_ROOT_TOKEN"), "root");
  assertEquals(h.writes.find((w) => w.specName === "initState")?.data.keyThreshold, 2);
});

Deno.test("initialize skips when OpenBao is already initialized", async () => {
  const h = context({
    "/v1/sys/init": () => json({ initialized: true }),
  });

  await model.methods.initialize.execute({ vaultName: "local", keyShares: 5, keyThreshold: 3 }, h.ctx);

  assertEquals(h.secrets.size, 0);
  assertEquals(h.writes.find((w) => w.specName === "initState")?.data.skipped, true);
});

Deno.test("unseal sends one key share and records progress", async () => {
  const h = context({
    "/v1/sys/unseal": (init?: RequestInit) => {
      assertEquals(init?.method, "PUT");
      assertEquals(JSON.parse(String(init?.body)).key, "share-1");
      return json({ progress: 1, t: 3, sealed: true });
    },
  });

  await model.methods.unseal.execute({ unsealKey: "share-1" }, h.ctx);

  assertEquals(h.writes[0].specName, "unseal");
  assertEquals(h.writes[0].data.progress, 1);
  assertEquals(h.writes[0].data.threshold, 3);
  assertEquals(h.writes[0].data.sealed, true);
});

Deno.test("seal sends token header and records seal state", async () => {
  const h = context({
    "/v1/sys/seal": (init?: RequestInit) => {
      assertEquals(init?.method, "PUT");
      assertEquals((init?.headers as Record<string, string>)["x-vault-token"], "root-token");
      return json({});
    },
  });

  await model.methods.seal.execute({ token: "root-token" }, h.ctx);

  assertEquals(h.writes[0].specName, "seal");
  assert(h.writes[0].data.sealedAt);
});
