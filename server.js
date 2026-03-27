import "dotenv/config";
import crypto from "crypto";
import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import multer from "multer";
import FormData from "form-data";
import fetch from "node-fetch";
import fs from "fs";

// ─── Config ───────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const APP_SECRET = process.env.APP_SECRET;

if (!ELEVENLABS_API_KEY) {
  console.error("[FATAL] ELEVENLABS_API_KEY is not set. Exiting.");
  process.exit(1);
}

if (!APP_SECRET) {
  console.error("[FATAL] APP_SECRET is not set. Exiting.");
  process.exit(1);
}

// ─── Express Setup ────────────────────────────────────────────────────────────

const app = express();

// CORS — only allow requests from the app's backend domain (not browser)
// For a mobile-only backend, this is informational; primary protection is APP_SECRET.
app.use(cors({ origin: false }));

app.use(express.json({ limit: "16kb" }));

// ─── Rate Limiting ────────────────────────────────────────────────────────────

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,        // 1 minute window
  max: 30,                    // max 30 requests per IP per minute (all /api routes)
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please try again later." },
});

const cloneLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,  // 1 hour window
  max: 5,                     // max 5 voice-clone attempts per IP per hour
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Voice clone limit reached. Try again later." },
});

app.use("/api", apiLimiter);

// ─── File Upload ──────────────────────────────────────────────────────────────

const ALLOWED_AUDIO_MIMES = new Set([
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/x-wav",
  "audio/mp4",
  "audio/x-m4a",
  "audio/aac",
  "audio/ogg",
  "audio/webm",
]);

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

const upload = multer({
  dest: "/tmp/sayitalarm/",
  limits: { fileSize: MAX_FILE_SIZE, files: 1 },
  fileFilter(_req, file, cb) {
    if (ALLOWED_AUDIO_MIMES.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Invalid file type. Only audio files are accepted."));
    }
  },
});

// ─── Auth Middleware ──────────────────────────────────────────────────────────

function requireAppSecret(req, res, next) {
  const provided = req.headers["x-app-secret"] ?? "";
  const expected = APP_SECRET;

  // Constant-time comparison prevents timing attacks
  const providedBuf = Buffer.alloc(64);
  const expectedBuf = Buffer.alloc(64);
  providedBuf.write(provided);
  expectedBuf.write(expected);

  if (!crypto.timingSafeEqual(providedBuf, expectedBuf)) {
    console.warn(`[AUTH] Unauthorized request from ${req.ip} — ${req.method} ${req.path}`);
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

app.use("/api", requireAppSecret);

// ─── Health Check ─────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => res.json({ status: "ok" }));

// ─── POST /api/clone-voice ────────────────────────────────────────────────────
//
// Receives:  multipart/form-data
//   - file   : audio file (m4a / mp3 / wav)
//   - name   : string (optional, voice display name)
//
// Returns:   { voice_id: string }

app.post(
  "/api/clone-voice",
  cloneLimiter,
  upload.single("file"),
  async (req, res) => {
    const file = req.file;
    if (!file) return res.status(400).json({ error: "No audio file provided" });

    try {
      // Sanitize voice name — strip anything non-printable
      const rawName = typeof req.body.name === "string" ? req.body.name : "";
      const voiceName = rawName.replace(/[^\x20-\x7E]/g, "").trim().slice(0, 100)
        || `SayItAlarm-${Date.now()}`;

      const form = new FormData();
      form.append("name", voiceName);
      form.append("description", "SayItAlarm voice clone");
      form.append("files", fs.createReadStream(file.path), {
        filename: `voice_sample.${file.mimetype?.split("/")[1] || "m4a"}`,
        contentType: file.mimetype || "audio/x-m4a",
      });

      const upstream = await fetch("https://api.elevenlabs.io/v1/voices/add", {
        method: "POST",
        headers: {
          "xi-api-key": ELEVENLABS_API_KEY,
          ...form.getHeaders(),
        },
        body: form,
      });

      const json = await upstream.json();

      if (!upstream.ok) {
        console.error(`[API] clone-voice upstream error ${upstream.status}`);
        // Return a sanitized error — don't expose upstream internals
        const safeMsg = upstream.status === 422
          ? "Invalid audio file. Please use a clear voice recording."
          : "Voice cloning failed. Please try again.";
        return res.status(upstream.status >= 500 ? 502 : upstream.status).json({ error: safeMsg });
      }

      res.json({ voice_id: json.voice_id });
    } catch (err) {
      console.error("[API] clone-voice internal error:", err.message);
      res.status(500).json({ error: "Internal server error." });
    } finally {
      if (file?.path) fs.unlink(file.path, () => {});
    }
  }
);

// ─── POST /api/synthesize ──────────────────────────────────────────────────────
//
// Receives:  JSON  { text: string, voiceID: string }
// Returns:   audio/mpeg  (raw MP3 bytes)

app.post("/api/synthesize", async (req, res) => {
  const { text, voiceID } = req.body;

  if (!text || typeof text !== "string" || text.trim().length === 0) {
    return res.status(400).json({ error: "text is required." });
  }
  if (!voiceID || typeof voiceID !== "string" || voiceID.trim().length === 0) {
    return res.status(400).json({ error: "voiceID is required." });
  }
  // Basic input limits
  if (text.length > 5000) {
    return res.status(400).json({ error: "text must be 5000 characters or fewer." });
  }
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(voiceID.trim())) {
    return res.status(400).json({ error: "Invalid voiceID format." });
  }

  try {
    const upstream = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceID.trim()}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": ELEVENLABS_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text: text.trim(),
          model_id: "eleven_multilingual_v2",
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.85,
            style: 0.0,
            use_speaker_boost: true,
          },
        }),
      }
    );

    if (!upstream.ok) {
      console.error(`[API] synthesize upstream error ${upstream.status}`);
      const safeMsg = upstream.status === 404
        ? "Voice not found."
        : "Speech synthesis failed. Please try again.";
      return res.status(upstream.status >= 500 ? 502 : upstream.status).json({ error: safeMsg });
    }

    // Stream MP3 directly back to the iOS app
    res.set("Content-Type", "audio/mpeg");
    upstream.body.pipe(res);
  } catch (err) {
    console.error("[API] synthesize internal error:", err.message);
    res.status(500).json({ error: "Internal server error." });
  }
});

// ─── Multer error handler ─────────────────────────────────────────────────────

app.use((err, _req, res, next) => {
  if (err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: "File too large. Maximum size is 10 MB." });
  }
  if (err.message?.startsWith("Invalid file type")) {
    return res.status(415).json({ error: err.message });
  }
  next(err);
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () =>
  console.log(`SayItAlarm backend listening on port ${PORT}`)
);
