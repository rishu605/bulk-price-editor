/**
 * The fake Shopify, served over real HTTP on loopback.
 *
 * Three reasons this is a server rather than an injected object:
 *
 *   The worker-kill scenarios run the engine in a child process. The store's state
 *   has to outlive that process so the parent can still ask what actually landed.
 *
 *   Faults belong on the wire. A dropped socket is a dropped socket; simulating one
 *   in-process leaves the real client's error handling untested, and that handling is
 *   what decides whether a failure is retryable or terminal.
 *
 *   The bulk path uploads with `fetch` and streams results back with `fetch`. Stubbing
 *   the global would let those scenarios pass without exercising the code they exist
 *   to test.
 *
 * The web process still never writes prices -- this is the store, not the app.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { BlobStore } from "./blob-store";
import { FaultBoard, wireShapeOf } from "./faults";
import { FakeShopify } from "./fake-shopify";

export class FakeShopifyServer implements BlobStore {
  readonly faults = new FaultBoard();
  readonly fake: FakeShopify;

  private server?: Server;
  private readonly blobs = new Map<string, string>();
  private port = 0;

  constructor(options: { pollsBeforeComplete?: number } = {}) {
    this.fake = new FakeShopify({ blobs: this, ...options });
  }

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch((error) => {
        if (!response.headersSent) response.writeHead(500);
        response.end(String(error));
      });
    });

    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.port = (this.server!.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      this.server!.close((error) => (error ? reject(error) : resolve()));
    });
    this.server = undefined;
  }

  /** Where a client should POST GraphQL. Passed to child processes as an env var. */
  endpoint(): string {
    return `${this.origin()}/graphql`;
  }

  // ------------------------------------------------------------- BlobStore

  uploadUrl(): string {
    return `${this.origin()}/staged`;
  }

  put(key: string, body: string): string {
    this.blobs.set(key, body);
    return `${this.origin()}/blob/${encodeURIComponent(key)}`;
  }

  get(key: string): string | undefined {
    return this.blobs.get(key);
  }

  private origin(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  // ---------------------------------------------------------------- routing

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", this.origin());

    if (request.method === "POST" && url.pathname === "/graphql") {
      return this.graphql(request, response);
    }
    if (request.method === "POST" && url.pathname === "/staged") {
      return this.stagedUpload(request, response);
    }
    if (request.method === "GET" && url.pathname.startsWith("/blob/")) {
      const body = this.blobs.get(decodeURIComponent(url.pathname.slice("/blob/".length)));
      if (body === undefined) {
        response.writeHead(404).end("no such blob");
        return;
      }
      response.writeHead(200, { "content-type": "text/jsonl" }).end(body);
      return;
    }

    response.writeHead(404).end();
  }

  private async graphql(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const raw = await readBody(request);
    const { query, variables } = JSON.parse(raw.toString("utf8")) as {
      query: string;
      variables?: Record<string, unknown>;
    };

    const fault = this.faults.consider(query, variables ?? {});
    if (fault) {
      const shape = wireShapeOf(fault);
      if (shape.body === "destroy") {
        request.destroy();
        response.socket?.destroy();
        return;
      }
      response
        .writeHead(shape.status, { "content-type": "application/json" })
        .end(JSON.stringify(shape.body));
      return;
    }

    const result = await this.fake.request(query, variables ?? {});
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify(result));
  }

  private async stagedUpload(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readBody(request);

    // Parsed as a genuine multipart body, so a wrong field order or a missing part
    // fails here exactly as Shopify's storage backend would.
    const form = await new Response(new Uint8Array(body), {
      headers: { "content-type": request.headers["content-type"] ?? "" },
    }).formData();

    const key = String(form.get("key") ?? "");
    const file = form.get("file");
    if (!key || file === null || typeof file === "string") {
      response.writeHead(400).end("missing key or file");
      return;
    }

    this.blobs.set(key, await file.text());
    response.writeHead(201).end();
  }
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}
