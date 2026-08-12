// Community scene gallery — Vercel serverless function over Vercel Blob.
// GET  /api/gallery  → { scenes: [{ id, name, author, created, size, url }] }
// POST /api/gallery  { name, author?, code } → { ok, id, url }
// Scene JSON lives in the blob; name/author are base64url-encoded into the
// pathname so listing needs no per-blob fetch. Clients fetch scene.url directly.
import { del, list, put } from "@vercel/blob";
import { createHmac } from "node:crypto";

const PREFIX = "scenes/";
/** newest N returned to a browser: the whole store is walked, but the response
 *  stays a fixed size no matter how large the gallery grows */
const PAGE = 200;
/** stop walking pathologically large stores rather than time the function out */
const MAX_PAGES = 20;
/** uploads allowed across everyone in a rolling minute — a public endpoint that
 *  writes to paid storage needs a ceiling, and this one needs no state of its
 *  own because the timestamps are already in the pathnames */
const BURST = 10;
const BURST_MS = 60_000;
/** total scenes the store will hold before it stops accepting new ones. It
 *  refuses rather than evicting: deleting someone else's scene to make room for
 *  yours is not a policy anyone agreed to. */
const CAPACITY = 600;

interface Listed { pathname: string; url: string; size: number; uploadedAt: string | Date }

/** walk every page of the store; blob list() caps at 1000 per call, and the
 *  single un-paged call this used to make silently dropped everything after */
async function listAll(prefix: string): Promise<Listed[]> {
  const out: Listed[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await list({ prefix, limit: 1000, cursor });
    out.push(...(r.blobs as unknown as Listed[]));
    if (!r.hasMore || !r.cursor) break;
    cursor = r.cursor;
  }
  return out;
}
// The delete token is DERIVED, never stored: an attacker would have to forge
// an HMAC rather than fetch a token blob whose URL is guessable from the
// listing. The blob store credential doubles as the signing key.
const ownerToken = (stamp: string): string =>
  createHmac("sha256", process.env.BLOB_READ_WRITE_TOKEN ?? "granulab")
    .update(stamp).digest("base64url").slice(0, 24);
const b64u = (s: string): string => Buffer.from(s, "utf8").toString("base64url");
const unb64u = (s: string): string => Buffer.from(s, "base64url").toString("utf8");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function handler(req: any, res: any): Promise<void> {
  res.setHeader("Cache-Control", "no-store");
  try {
    if (req.method === "GET") {
      const blobs = await listAll(PREFIX);
      const scenes = blobs
        .map((b) => {
          const parts = b.pathname.slice(PREFIX.length).replace(/\.json$/, "").split(".");
          let name = "";
          let author = "";
          try {
            name = unb64u(parts[1] ?? "");
            author = unb64u(parts[2] ?? "");
          } catch { /* malformed pathname: show as untitled */ }
          return {
            id: b.pathname,
            stamp: parts[0] ?? "",
            name: name || "untitled",
            author,
            created: new Date(b.uploadedAt).getTime(),
            size: b.size,
            url: b.url,
          };
        })
        .sort((a, z) => z.created - a.created);
      res.status(200).json({ scenes: scenes.slice(0, PAGE), total: scenes.length, shown: Math.min(PAGE, scenes.length) });
      return;
    }
    if (req.method === "POST") {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const name = String(body.name ?? "").trim().slice(0, 40);
      const author = String(body.author ?? "").trim().slice(0, 24);
      const code = body.code;
      if (!name) { res.status(400).json({ error: "scene name required" }); return; }
      if (typeof code !== "string" || !code.startsWith("GLAB1.") || code.length > 400_000) {
        res.status(400).json({ error: "not a Granulab scene code" });
        return;
      }
      // a thumbnail makes the browse list readable at a glance; keep it small
      const thumb = typeof body.thumb === "string" && body.thumb.startsWith("data:image/")
        && body.thumb.length < 120_000 ? body.thumb : "";
      // The stamp is base36 milliseconds, so the store already carries every
      // upload time — the rate limit needs no state of its own.
      const existing = await listAll(PREFIX);
      if (existing.length >= CAPACITY) {
        res.status(507).json({ error: "the gallery is full — nothing new can be uploaded right now" });
        return;
      }
      const now = Date.now();
      const recent = existing.filter((b) => {
        const t = parseInt(b.pathname.slice(PREFIX.length).split(".")[0] ?? "", 36);
        return Number.isFinite(t) && now - t < BURST_MS;
      }).length;
      if (recent >= BURST) {
        res.setHeader("Retry-After", "60");
        res.status(429).json({ error: "too many uploads in the last minute — try again shortly" });
        return;
      }
      const stamp = now.toString(36) + Math.random().toString(36).slice(2, 6);
      const id = `${PREFIX}${stamp}.${b64u(name)}.${b64u(author) || "0"}.json`;
      const blob = await put(id, JSON.stringify({ name, author, code, thumb, created: Date.now() }), {
        access: "public",
        addRandomSuffix: false,
        contentType: "application/json",
      });
      res.status(200).json({ ok: true, id, url: blob.url, stamp, token: ownerToken(stamp) });
      return;
    }
    if (req.method === "DELETE") {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const stamp = String(body.stamp ?? "").replace(/[^a-z0-9]/gi, "");
      const token = String(body.token ?? "");
      if (!stamp || !token) { res.status(400).json({ error: "stamp and token required" }); return; }
      if (token !== ownerToken(stamp)) { res.status(403).json({ error: "not your upload" }); return; }
      const { blobs: scenes } = await list({ prefix: `${PREFIX}${stamp}.`, limit: 1 });
      /* one exact-prefix lookup: no pagination needed for a single stamp */
      if (!scenes.length) { res.status(404).json({ error: "unknown scene" }); return; }
      await del(scenes[0].url);
      res.status(200).json({ ok: true });
      return;
    }
    res.setHeader("Allow", "GET, POST, DELETE");
    res.status(405).json({ error: "method not allowed" });
  } catch (err) {
    // log the detail, hand the caller a message that leaks no internals
    console.error("[gallery]", err);
    res.status(500).json({ error: "the gallery backend failed — try again later" });
  }
}
