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

export default defineConfig({
  plugins: [shotSink()],
});
