import "dotenv/config";
import express from "express";
import { MongoClient } from "mongodb";
import { randomUUID } from "crypto";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { MONGO_URI, ADMIN_KEY, PORT = 3000 } = process.env;
if (!MONGO_URI) throw new Error("Falta MONGO_URI en las variables de entorno");

const client = new MongoClient(MONGO_URI);
await client.connect();
const col = client.db().collection("registros");
await col.createIndex({ documento: 1 }, { unique: true });

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "10kb" }));
app.use(express.static(path.join(__dirname, "public")));

// Límite simple: 10 registros por minuto por IP
const hits = new Map();
setInterval(() => hits.clear(), 60_000).unref();
const limitar = (req, res, next) => {
  const n = (hits.get(req.ip) || 0) + 1;
  hits.set(req.ip, n);
  return n > 10 ? res.status(429).json({ error: "Demasiados intentos, espera un minuto." }) : next();
};

app.post("/api/registro", limitar, async (req, res) => {
  const nombre = String(req.body?.nombre ?? "").trim();
  const documento = String(req.body?.documento ?? "").trim();
  if (nombre.length < 3 || nombre.length > 100 || !/^\d{5,15}$/.test(documento))
    return res.status(400).json({ error: "Nombre o documento no válidos." });
  const id = randomUUID().replace(/-/g, "");
  try {
    await col.insertOne({ _id: id, nombre, documento, usado: false, creado: new Date() });
    res.json({ id });
  } catch (e) {
    if (e.code === 11000) return res.status(409).json({ error: "Este documento ya fue registrado." });
    console.error(e);
    res.status(500).json({ error: "Error del servidor." });
  }
});

app.get("/api/verificar/:id", async (req, res) => {
  const r = await col.findOne({ _id: req.params.id });
  if (!r) return res.status(404).json({ valido: false });
  res.json({ valido: true, nombre: r.nombre, documento: "•••" + r.documento.slice(-3), usado: r.usado });
});

app.post("/api/usar/:id", async (req, res) => {
  if (!ADMIN_KEY) return res.status(503).json({ error: "ADMIN_KEY no configurada." });
  if (req.get("x-admin-key") !== ADMIN_KEY) return res.status(401).json({ error: "Clave incorrecta." });
  const r = await col.findOneAndUpdate(
    { _id: req.params.id, usado: false },
    { $set: { usado: true, usadoEn: new Date() } }
  );
  r ? res.json({ ok: true }) : res.status(409).json({ error: "No existe o ya fue usado." });
});

app.get("/v/:id", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => console.log("Servidor en puerto " + PORT));
