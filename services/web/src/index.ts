import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Static web server for the demo UI. Serves public/index.html.
const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.static(join(__dirname, "..", "public")));

const port = Number(process.env.WEB_PORT ?? 4000);
app.listen(port, () => console.log(`[web] open http://localhost:${port}`));
