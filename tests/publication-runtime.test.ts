import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { transform } from "esbuild";
import { Miniflare } from "miniflare";

it("constructs publication requests in real workerd (Node fetch mocks missed unsupported redirect mode)", async () => {
  const repository = (
    await transform(
      readFileSync("mcp-worker/src/publication/repository.ts", "utf8"),
      { loader: "ts", format: "esm", target: "es2022" },
    )
  ).code;
  const script = `import { PublicationRepository } from './repository.js';
    export default { async fetch() {
      const requests = [];
      globalThis.fetch = async (url, init) => {
        // Use workerd's Request validation, not Node's implementation.
        const request = new Request(url, init);
        requests.push({redirect:request.redirect, aborted:request.signal.aborted});
        return Response.json({private:true});
      };
      const repo = new PublicationRepository({owner:'dummy',repo:'private',branch:'main',token:'dummy'});
      await repo.assertPrivate();
      return Response.json(requests);
    }};`;
  const mf = new Miniflare({
    workers: [
      {
        config: {
          name: "publication-runtime-test",
          compatibilityDate: "2026-10-06",
          compatibilityFlags: ["nodejs_compat"],
          manifest: {
            mainModule: "index.js",
            modulesRoot: process.cwd(),
            modules: {
              "index.js": { type: "esm", contents: script },
              "repository.js": { type: "esm", contents: repository },
            },
          },
        },
      },
    ],
  });
  try {
    const response = await mf.dispatchFetch("http://localhost/");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      { redirect: "manual", aborted: false },
    ]);
  } finally {
    await mf.dispose();
  }
}, 15000);
