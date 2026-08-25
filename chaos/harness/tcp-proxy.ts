/**
 * A TCP proxy the harness can cut.
 *
 * Postgres and Redis are the two dependencies the engine cannot function without, and
 * the interesting question about both is what happens when they go away *mid-run* --
 * not at startup, where every system handles it, but after the ledger is committed and
 * halfway through the writes.
 *
 * Stopping the real service is not an option: the harness itself needs the database to
 * assert anything afterwards. Proxying the connection and destroying the sockets gives
 * a precise, targeted outage -- this run loses its connection, everything else keeps
 * working -- which is both easier to reason about and closer to what actually happens
 * in production, where a failover or a pod restart drops connections rather than
 * deleting the database.
 */

import { createServer, connect, type AddressInfo, type Server, type Socket } from "node:net";

export class TcpProxy {
  private server?: Server;
  private readonly sockets = new Set<Socket>();
  private port = 0;
  private open = true;

  constructor(
    private readonly targetHost: string,
    private readonly targetPort: number,
  ) {}

  async start(): Promise<void> {
    this.server = createServer((client) => {
      if (!this.open) {
        client.destroy();
        return;
      }

      const upstream = connect(this.targetPort, this.targetHost);
      this.track(client);
      this.track(upstream);

      client.pipe(upstream);
      upstream.pipe(client);

      // Either half closing takes the other with it, so a cut is seen on both sides
      // rather than leaving one end waiting on a socket that will never answer.
      const drop = () => {
        client.destroy();
        upstream.destroy();
      };
      client.on("error", drop);
      upstream.on("error", drop);
      client.on("close", drop);
      upstream.on("close", drop);
    });

    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.port = (this.server!.address() as AddressInfo).port;
  }

  /** Host:port a client should connect to instead of the real service. */
  address(): { host: string; port: number } {
    return { host: "127.0.0.1", port: this.port };
  }

  /**
   * Drops every connection and refuses new ones.
   *
   * Destroy rather than end: a graceful FIN lets the client finish what it was doing,
   * which is the opposite of the outage being modelled.
   */
  cut(): void {
    this.open = false;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
  }

  /** Service restored. New connections work; the dropped ones stay dropped. */
  restore(): void {
    this.open = true;
  }

  async stop(): Promise<void> {
    this.cut();
    if (!this.server) return;
    await new Promise<void>((resolve, reject) => {
      this.server!.close((error) => (error ? reject(error) : resolve()));
    });
    this.server = undefined;
  }

  private track(socket: Socket): void {
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));
  }
}

/** Rewrites a connection URL to point at a proxy instead of the real host. */
export function through(url: string, proxy: TcpProxy): string {
  const { host, port } = proxy.address();
  const parsed = new URL(url);
  parsed.hostname = host;
  parsed.port = String(port);
  return parsed.toString();
}

/** Splits a connection URL into the host and port a proxy should forward to. */
export function targetOf(url: string, defaultPort: number): { host: string; port: number } {
  const parsed = new URL(url);
  return { host: parsed.hostname, port: Number(parsed.port || defaultPort) };
}
