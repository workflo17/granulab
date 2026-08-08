import { defineConfig, type Plugin } from "vite";
import fs from "node:fs";
import path from "node:path";

// QA shot sink: the page POSTs canvas.toDataURL() here; we write a real PNG.
// Used by headless capture (tools/shot) because the compositor won't present
// WebGL surfaces to headless --screenshot reliably.
function shotSink(): Plugin {
  return {
    name: "granulab-shot-sink",
    configureServer(server) {
      server.middlewares.use("/__shot", (req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          const name = (new URL(req.url ?? "/", "http://x").searchParams.get("name") ?? "shot")
            .replace(/[^a-z0-9-]/gi, "");
          const b64 = body.slice(body.indexOf(",") + 1);
          const dir = path.join(__dirname, "tools", "shots");
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, `${name}.png`), Buffer.from(b64, "base64"));
          res.end("ok");
        });
      });
    },
  };
}

// Dev twin of api/gallery.ts: same routes and response shapes, backed by
// tools/gallery-store/ instead of Vercel Blob, so the gallery is QA-able
// on :4870 without deploying. Scene URLs point at /api/gallery/scene/<id>.
function galleryDev(): Plugin {
  const dir = path.join(__dirname, "tools", "gallery-store");
  const b64u = (s: string): string => Buffer.from(s, "utf8").toString("base64url");
  const unb64u = (s: string): string => Buffer.from(s, "base64url").toString("utf8");
  return {
    name: "granulab-gallery-dev",
    configureServer(server) {
      server.middlewares.use("/api/gallery", (req, res) => {
        const url = new URL(req.url ?? "/", "http://x");
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Cache-Control", "no-store");
        if (req.method === "GET" && url.pathname.startsWith("/scene/")) {
          const file = url.pathname.slice("/scene/".length).replace(/[^a-zA-Z0-9._-]/g, "");
          try {
            res.end(fs.readFileSync(path.join(dir, file)));
          } catch {
            res.statusCode = 404;
            res.end('{"error":"not found"}');
          }
          return;
        }
        if (req.method === "GET") {
          fs.mkdirSync(dir, { recursive: true });
          const scenes = fs.readdirSync(dir)
            .filter((f) => f.endsWith(".json"))
            .map((f) => {
              const parts = f.replace(/\.json$/, "").split(".");
              const st = fs.statSync(path.join(dir, f));
              let name = "";
              let author = "";
              try { name = unb64u(parts[1] ?? ""); author = unb64u(parts[2] ?? ""); } catch { /* untitled */ }
              return { id: f, name: name || "untitled", author, created: st.mtimeMs, size: st.size, url: "/api/gallery/scene/" + f };
            })
            .sort((a, z) => z.created - a.created);
          res.end(JSON.stringify({ scenes }));
          return;
        }
        if (req.method === "POST") {
          let body = "";
          req.on("data", (c) => (body += c));
          req.on("end", () => {
            try {
              const j = JSON.parse(body) as Record<string, unknown>;
              const name = String(j.name ?? "").trim().slice(0, 40);
              const author = String(j.author ?? "").trim().slice(0, 24);
              const code = j.code;
              if (!name || typeof code !== "string" || !code.startsWith("GLAB1.") || code.length > 400_000) {
                res.statusCode = 400;
                res.end('{"error":"bad upload"}');
                return;
              }
              fs.mkdirSync(dir, { recursive: true });
              const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
              const id = `${stamp}.${b64u(name)}.${b64u(author) || "0"}.json`;
              fs.writeFileSync(path.join(dir, id), JSON.stringify({ name, author, code, created: Date.now() }));
              res.end(JSON.stringify({ ok: true, id, url: "/api/gallery/scene/" + id }));
            } catch {
              res.statusCode = 400;
              res.end('{"error":"bad json"}');
            }
          });
          return;
        }
        res.statusCode = 405;
        res.end('{"error":"method not allowed"}');
      });
    },
  };
}

export default defineConfig({
  plugins: [shotSink(), galleryDev()],
  // top-level await (engine boot); the app already needs CompressionStream,
  // so es2022 doesn't narrow the supported-browser set
  build: { target: "es2022" },
  // PORT lets the preview harness assign a free port (worktree sessions);
  // standalone `npm run dev` still lands on 4870
  server: { port: Number(process.env.PORT) || 4870, strictPort: true },
  preview: { port: Number(process.env.PORT) || 4870, strictPort: true },
});
