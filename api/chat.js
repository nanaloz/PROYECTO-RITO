// api/chat.js
// ⚡ OPTIMIZADO PARA RESPONDER MÁS RÁPIDO SIN CAMBIAR TU FRONTEND

export default async function handler(req, res) { 
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Método no permitido" });
  }

  const { message, threadId: incomingThreadId } = req.body || {};
  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: "El mensaje no puede estar vacío." });
  }

  // === Ajustes de rendimiento ===
  const POLL_INTERVAL_MS = 350;           // ↓ de 1200ms a 350ms
  const MAX_WAIT_MS      = 20000;         // tope 20s para no bloquear
  const MESSAGES_LIMIT_QS = "limit=1&order=desc"; // trae solo el último mensaje

  try {
    let threadId = incomingThreadId;

    // 1) Crear hilo si no vino uno del front
    if (!threadId) {
      const threadResponse = await fetch("https://api.openai.com/v1/threads", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
          "OpenAI-Beta": "assistants=v2"
        }
      });
      if (!threadResponse.ok) {
        const err = await threadResponse.text();
        return res.status(threadResponse.status).json({ error: safeText(err) });
      }
      const threadData = await threadResponse.json();
      threadId = threadData.id;
    }

    // 2) Añadir mensaje del usuario (role=user)
    {
      const msgResp = await fetch(`https://api.openai.com/v1/threads/${threadId}/messages`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
          "OpenAI-Beta": "assistants=v2"
        },
        body: JSON.stringify({ role: "user", content: message })
      });
      if (!msgResp.ok) {
        const err = await msgResp.text();
        return res.status(msgResp.status).json({ error: safeText(err) });
      }
    }

    // 3) Lanzar run del asistente
    const runResp = await fetch(`https://api.openai.com/v1/threads/${threadId}/runs`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
        "OpenAI-Beta": "assistants=v2"
      },
      body: JSON.stringify({
        assistant_id: process.env.OPENAI_ASSISTANT_ID,
        // 👇 Pistas para que sea conciso y no se eternice
        instructions: "Responde de forma breve y directa. Evita preámbulos innecesarios."
      })
    });
    if (!runResp.ok) {
      const err = await runResp.text();
      return res.status(runResp.status).json({ error: safeText(err) });
    }
    const runData = await runResp.json();
    const runId = runData.id;

    // 4) Poll hasta completar (rápido + con timeout)
    const startedAt = Date.now();
    let status = runData.status || "queued";

    while (status === "queued" || status === "in_progress") {
      // timeout de seguridad
      if (Date.now() - startedAt > MAX_WAIT_MS) {
        return res.status(504).json({ error: "Timeout esperando la respuesta del asistente." });
      }
      await sleep(POLL_INTERVAL_MS);

      const checkResp = await fetch(
        `https://api.openai.com/v1/threads/${threadId}/runs/${runId}`,
        {
          method: "GET",
          headers: {
            "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
            "OpenAI-Beta": "assistants=v2"
          }
        }
      );
      if (!checkResp.ok) {
        const err = await checkResp.text();
        return res.status(checkResp.status).json({ error: safeText(err) });
      }
      const checkData = await checkResp.json();
      status = checkData.status;
      if (status === "requires_action") {
        // Si tu asistente usa tools, aquí atenderías las tool calls rápidamente.
        // Para ir rápido, devolvemos un error controlado (o impleméntalo según tu caso).
        return res.status(409).json({ error: "El asistente requiere acción (tools). Implementa tool calls si procede." });
      }
    }

    // 5) Leer SOLO el último mensaje del hilo (más rápido)
    const msgsResp = await fetch(
      `https://api.openai.com/v1/threads/${threadId}/messages?${MESSAGES_LIMIT_QS}`,
      {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
          "OpenAI-Beta": "assistants=v2"
        }
      }
    );
    if (!msgsResp.ok) {
      const err = await msgsResp.text();
      return res.status(msgsResp.status).json({ error: safeText(err) });
    }
    const msgsData = await msgsResp.json();

    // Buscamos el último mensaje del asistente
    const assistantMessage = (msgsData.data || []).find((m) => m.role === "assistant");
    if (!assistantMessage || !assistantMessage.content) {
      return res.status(200).json({
        threadId,
        response: "El asistente no proporcionó una respuesta válida."
      });
    }

    let responseText = extractTextFromAssistantMessage(assistantMessage);
    responseText = responseText.replace(/【\d+:\d+†[^】]+】/g, "").trim();

    return res.status(200).json({ threadId, response: responseText });

  } catch (error) {
    console.error("❌ Error inesperado:", error);
    return res.status(500).json({ error: "Error en la solicitud a OpenAI" });
  }
}

/* === Helpers === */

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function safeText(t) {
  if (!t) return "";
  if (typeof t === "string") return t;
  try { return JSON.stringify(t); } catch { return String(t); }
}

function extractTextFromAssistantMessage(msg) {
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter(item => item.type === "text" && item.text?.value)
      .map(item => item.text.value)
      .join("\n");
  }
  if (typeof msg.content === "string") return msg.content;
  try { return JSON.stringify(msg.content); } catch { return String(msg.content); }
}

