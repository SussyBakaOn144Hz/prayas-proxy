import express from "express";

const app = express();

// Allow browser-based RP frontends (CORS)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// High limit so large RP presets, lorebooks, and long histories never fail
app.use(express.json({ limit: "15mb" }));

const UPSTREAM_URL = "https://api.prayas.click/api/proxy-chat";
const ENDPOINT_ID = "ep_1787629305773";

app.get("/v1/models", (req, res) => {
  res.json({
    object: "list",
    data: [{ id: ENDPOINT_ID, object: "model", created: Math.floor(Date.now() / 1000) }],
  });
});

app.post("/v1/chat/completions", async (req, res) => {
  try {
    const { messages = [], stream = false } = req.body;

    // Reads whatever eyJ... token you paste into your RP frontend's API Key box
    const authHeader = req.headers.authorization || "";
    if (!authHeader || authHeader === "Bearer") {
      return res.status(401).json({
        error: { message: "Paste your eyJ... token into your RP frontend's API Key field." },
      });
    }

    const upstream = await fetch(UPSTREAM_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader,
      },
      body: JSON.stringify({
        endpointId: ENDPOINT_ID,
        messages,
      }),
    });

    if (!upstream.ok) {
      const errText = await upstream.text();
      return res.status(upstream.status).json({ error: { message: errText } });
    }

    const contentType = upstream.headers.get("content-type") || "";

    // Forward live SSE chunks if upstream streams
    if (contentType.includes("text/event-stream") && stream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      const reader = upstream.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
      return res.end();
    }

    // Parse full JSON or plain-text response
    const rawText = await upstream.text();
    let replyText = rawText;
    try {
      const data = JSON.parse(rawText);
      replyText =
        data.choices?.[0]?.message?.content ??
        data.reply ??
        data.content ??
        data.message ??
        rawText;
    } catch {
      // Plain text fallback
    }

    const id = `chatcmpl-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);

    // Emit valid OpenAI SSE chunks if your RP frontend has text streaming turned on
    if (stream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      res.write(
        `data: ${JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created,
          model: ENDPOINT_ID,
          choices: [{ index: 0, delta: { role: "assistant", content: replyText }, finish_reason: null }],
        })}\n\n`
      );
      res.write(
        `data: ${JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created,
          model: ENDPOINT_ID,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })}\n\n`
      );
      res.write("data: [DONE]\n\n");
      return res.end();
    }

    return res.json({
      id,
      object: "chat.completion",
      created,
      model: ENDPOINT_ID,
      choices: [{ index: 0, message: { role: "assistant", content: replyText }, finish_reason: "stop" }],
    });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`RP Proxy ready on http://localhost:${PORT}/v1`));
