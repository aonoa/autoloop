// One public webhook entry for several GitHub repositories: read the repository from the payload and forward the signed
// request to that repository's own source. The hub still verifies each source's signature, so this router can't grant
// work by itself; it only chooses a door. Run with `--self-test` to check the mapping without a hub or network.
import { createServer } from "node:http";

type Route = { repo: string; source: string };

const ROUTES: Route[] = [
  { repo: "owner/app", source: "github-app" },
  { repo: "owner/web", source: "github-web" },
];

/** The repository a GitHub payload names; absent or malformed payloads get no source. */
export function repositoryOf(body: string): string {
  try {
    const payload = JSON.parse(body);
    const name = payload?.repository?.full_name;
    return typeof name === "string" ? name : "";
  } catch {
    return "";
  }
}

/** The source a repository belongs to, or null when it isn't one this router knows. */
export function sourceFor(repo: string, routes: Route[] = ROUTES): string | null {
  return routes.find((route) => route.repo === repo)?.source ?? null;
}

const read = (request: import("node:http").IncomingMessage) =>
  new Promise<string>((resolve, reject) => {
    const parts: Buffer[] = [];
    request.on("data", (part) => parts.push(Buffer.from(part)));
    request.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
    request.on("error", reject);
  });

const signature = (headers: import("node:http").IncomingHttpHeaders) => {
  const value = headers["x-hub-signature-256"];
  return Array.isArray(value) ? value[0] : value;
};

async function serve() {
  const hub = process.env.AGENT_AUTOLOOP_URL ?? "http://127.0.0.1:3350";
  const listen = process.env.ROUTE_LISTEN ?? "127.0.0.1:3351";
  const [host, port = "3351"] = listen.includes("[") ? listen.split("]:") : listen.split(":");
  const server = createServer(async (request, response) => {
    if (request.url !== "/github") {
      response.writeHead(404).end("not found");
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405).end("method not allowed");
      return;
    }
    const body = await read(request);
    const source = sourceFor(repositoryOf(body));
    if (!source) {
      // A repository this router doesn't know is recorded nowhere: don't invent a source or a secret for it.
      response.writeHead(202, { "content-type": "application/json" }).end(JSON.stringify({ ignored: true }));
      return;
    }
    const headers: Record<string, string> = { "content-type": "application/json" };
    for (const name of ["x-github-event", "x-github-delivery", "x-hub-signature-256"]) {
      const value = name === "x-hub-signature-256" ? signature(request.headers) : request.headers[name];
      if (typeof value === "string") headers[name] = value;
    }
    const forwarded = await fetch(`${hub.replace(/\/$/, "")}/v1/in/${source}`, { method: "POST", headers, body });
    response.writeHead(forwarded.status, { "content-type": "application/json" });
    response.end(await forwarded.text());
  });
  server.listen(Number(port), host, () => console.log(`listening on http://${listen}/github`));
}

if (process.argv.includes("--self-test")) {
  const checks: [string, string | null, string | null][] = [
    ["app", repositoryOf(JSON.stringify({ repository: { full_name: "owner/app" } })), "owner/app"],
    ["web", repositoryOf(JSON.stringify({ repository: { full_name: "owner/web" } })), "owner/web"],
    ["unknown repo", sourceFor("owner/other"), null],
    ["malformed payload", repositoryOf("not json"), ""],
    ["app source", sourceFor("owner/app"), "github-app"],
    ["web source", sourceFor("owner/web"), "github-web"],
  ];
  for (const [name, given, expected] of checks) {
    if (given !== expected) throw new Error(`route mismatch: ${given} != ${expected}`);
  }
  console.log(`ok: ${ROUTES.map((route) => `${route.repo} → ${route.source}`).join(", ")}`);
} else {
  await serve();
}
