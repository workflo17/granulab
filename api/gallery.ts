// Community scene gallery — Vercel serverless function over Vercel Blob.
// GET  /api/gallery  → { scenes: [{ id, name, author, created, size, url }] }
// POST /api/gallery  { name, author?, code } → { ok, id, url }
// Scene JSON lives in the blob; name/author are base64url-encoded into the
// pathname so listing needs no per-blob fetch. Clients fetch scene.url directly.
import { list, put } from "@vercel/blob";

const PREFIX = "scenes/";
const b64u = (s: string): string => Buffer.from(s, "utf8").toString("base64url");
const unb64u = (s: string): string => Buffer.from(s, "base64url").toString("utf8");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function handler(req: any, res: any): Promise<void> {
  res.setHeader("Cache-Control", "no-store");
  try {
    if (req.method === "GET") {
      const { blobs } = await list({ prefix: PREFIX, limit: 1000 });
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
            name: name || "untitled",
            author,
            created: new Date(b.uploadedAt).getTime(),
            size: b.size,
            url: b.url,
          };
        })
        .sort((a, z) => z.created - a.created);
      res.status(200).json({ scenes });
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
      const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const id = `${PREFIX}${stamp}.${b64u(name)}.${b64u(author) || "0"}.json`;
      const blob = await put(id, JSON.stringify({ name, author, code, created: Date.now() }), {
        access: "public",
        addRandomSuffix: false,
        contentType: "application/json",
      });
      res.status(200).json({ ok: true, id, url: blob.url });
      return;
    }
    res.setHeader("Allow", "GET, POST");
    res.status(405).json({ error: "method not allowed" });
  } catch (err) {
    res.status(500).json({ error: String((err as Error)?.message ?? err) });
  }
}
