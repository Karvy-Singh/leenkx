import { DurableObject } from "cloudflare:workers";

const PORT = 8080;
const INACTIVITY_TIMEOUT_MS = 60 * 60 * 1000;
const CHUNK_SIZE = 100_000;

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

async function sha256(value: string): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(value);
  const input = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(input).set(bytes);
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", input),
  );
}

async function encryptionKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    await sha256(secret),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

export class WhatsAppSession extends DurableObject<Env> {
  private starting: Promise<void> | undefined;
  private snapshotting: Promise<void> | undefined;

  async fetch(request: Request): Promise<Response> {
    const token = request.headers.get("authorization")?.replace(/^Bearer /, "");
    if (!token || !(await this.authorize(token))) {
      return json({ error: "Unauthorized session" }, 401);
    }

    const pathname = new URL(request.url).pathname;
    if (pathname.startsWith("/internal/")) {
      return json({ error: "Not found" }, 404);
    }

    this.starting ??= this.startContainer().finally(() => {
      this.starting = undefined;
    });
    await this.starting;

    const url = new URL(request.url);
    url.protocol = "http:";
    url.host = "container";
    const forwarded = new Request(url, request);
    forwarded.headers.delete("host");
    forwarded.headers.delete("authorization");
    const response = await this.ctx.container!.getTcpPort(PORT).fetch(forwarded);

    if (response.headers.get("x-session-dirty") === "1") {
      this.ctx.waitUntil(this.snapshot());
    }

    const clean = new Response(response.body, response);
    clean.headers.delete("x-session-dirty");
    clean.headers.set("cache-control", "no-store");
    return clean;
  }

  private async authorize(token: string): Promise<boolean> {
    const provided = await sha256(token);
    const stored = await this.ctx.storage.get<Uint8Array>("owner-token");
    if (!stored) {
      await this.ctx.storage.put("owner-token", provided);
      return true;
    }
    const expected = new Uint8Array(stored);
    if (provided.length !== expected.length) return false;
    let difference = 0;
    for (let index = 0; index < provided.length; index++) {
      difference |= provided[index] ^ expected[index];
    }
    return difference === 0;
  }

  private async startContainer(): Promise<void> {
    const container = this.ctx.container!;
    const startingFresh = !container.running;
    if (startingFresh) {
      container.start({
        image: container.images.base,
        instance: "lite",
        enableInternet: true,
      });
    }
    await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);

    const port = container.getTcpPort(PORT);
    let lastError: unknown;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        const response = await port.fetch("http://container/health", {
          signal: AbortSignal.timeout(1000),
        });
        await response.body?.cancel();
        if (!response.ok) throw new Error(`Health check returned ${response.status}`);
        if (startingFresh) await this.restore();
        return;
      } catch (error) {
        lastError = error;
        await scheduler.wait(200);
      }
    }
    throw new Error("WhatsApp container failed to start", { cause: lastError });
  }

  private async snapshot(): Promise<void> {
    if (this.snapshotting) return this.snapshotting;
    this.snapshotting = this.saveSnapshot().finally(() => {
      this.snapshotting = undefined;
    });
    return this.snapshotting;
  }

  private async saveSnapshot(): Promise<void> {
    const response = await this.ctx.container!
      .getTcpPort(PORT)
      .fetch("http://container/internal/session");
    if (!response.ok) throw new Error(`Session snapshot failed: ${response.status}`);
    const plain = await response.arrayBuffer();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        await encryptionKey(this.env.SESSION_ENCRYPTION_KEY),
        plain,
      ),
    );
    const chunks = Math.ceil(encrypted.length / CHUNK_SIZE);
    const previous = await this.ctx.storage.get<{ chunks: number }>("session-meta");

    for (let index = 0; index < chunks; index++) {
      await this.ctx.storage.put(
        `session-${index}`,
        encrypted.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE),
      );
    }
    await this.ctx.storage.put("session-meta", { iv: [...iv], chunks });
    for (let index = chunks; index < (previous?.chunks ?? 0); index++) {
      await this.ctx.storage.delete(`session-${index}`);
    }
  }

  private async restore(): Promise<void> {
    const meta = await this.ctx.storage.get<{ iv: number[]; chunks: number }>(
      "session-meta",
    );
    if (!meta) return;

    const parts: Uint8Array[] = [];
    let length = 0;
    for (let index = 0; index < meta.chunks; index++) {
      const part = await this.ctx.storage.get<Uint8Array>(`session-${index}`);
      if (!part) throw new Error("Encrypted session is incomplete");
      const bytes = new Uint8Array(part);
      parts.push(bytes);
      length += bytes.length;
    }
    const encrypted = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
      encrypted.set(part, offset);
      offset += part.length;
    }
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: new Uint8Array(meta.iv) },
      await encryptionKey(this.env.SESSION_ENCRYPTION_KEY),
      encrypted,
    );
    const response = await this.ctx.container!
      .getTcpPort(PORT)
      .fetch("http://container/internal/session", {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: plain,
      });
    await response.body?.cancel();
    if (!response.ok) throw new Error(`Session restore failed: ${response.status}`);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      const sender = request.headers.get("x-sender")?.replace(/\D/g, "") ?? "";
      if (!/^\d{8,15}$/.test(sender)) {
        return json({ error: "Valid sender number required" }, 400);
      }
      return env.WHATSAPP.getByName(sender).fetch(request);
    }
    const asset = await env.ASSETS.fetch(request);
    const response = new Response(asset.body, asset);
    response.headers.set(
      "content-security-policy",
      "default-src 'self'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
    );
    response.headers.set("referrer-policy", "no-referrer");
    response.headers.set("x-content-type-options", "nosniff");
    response.headers.set("x-frame-options", "DENY");
    return response;
  },
} satisfies ExportedHandler<Env>;
