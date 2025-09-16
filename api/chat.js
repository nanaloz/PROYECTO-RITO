// api/chat.js
export default async function handler(req, res) { 
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Método no permitido" });
  }

  const { message, threadId: incomingThreadId } = req.body || {};
  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: "El mensaje no puede estar vacío." });
  }

  try {
    let threadId = incomingThreadId;

    // 1) Crear hilo si no viene uno del front
    if (!threadId) {
      const threadResponse = await fetch("https://api.openai.com/v1/threads", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
          "OpenAI-Beta": "assistants=v2"
        }
      });
      const threadData = await threadResponse.json();
      if (!threadResponse.ok) {
        return res.status(threadResponse.status).json({ error: threadData });
      }
      threadId = threadData.id;
    }

    // 2) Añadir mensaje del usuario
    const msgResp = await fetch(`https://api.openai.com/v1/threads/${threadId}/messages`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
        "OpenAI-Beta": "assistants=v2"
      },
      body: JSON.stringify({ role: "user", content: message })
    });
    const msgData = await msgResp.json();
    if (!msgResp.ok) {
      return res.status(msgResp.status).json({ error: msgData });
    }

    // 3) Lanzar run del asistente
    const runResp = await fetch(`https://api.openai.com/v1/threads/${threadId}/runs`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
        "OpenAI-Beta": "assistants=v2"
      },
      body: JSON.stringify({ assistant_id: process.env.OPENAI_ASSISTANT_ID })
    });
    const runData = await runResp.json();
    if (!runResp.ok) {
      return res.status(runResp.status).json({ error: runData });
    }
    const runId = runData.id;

    // 4) Poll hasta completar
    let status = "in_progress";
    while (status === "in_progress" || status === "queued") {
      await new Promise(r => setTimeout(r, 1200));
      const checkResp = await fetch(`https://api.openai.com/v1/threads/${threadId}/runs/${runId}`, {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
          "OpenAI-Beta": "assistants=v2"
        }
      });
      const checkData = await checkResp.json();
      if (!checkResp.ok) {
        return res.status(checkResp.status).json({ error: checkData });
      }
      status = checkData.status;
    }

    // 5) Leer mensajes del hilo
    const msgsResp = await fetch(`https://api.openai.com/v1/threads/${threadId}/messages`, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "OpenAI-Beta": "assistants=v2"
      }
    });
    const msgsData = await msgsResp.json();
    if (!msgsResp.ok) {
      return res.status(msgsResp.status).json({ error: msgsData });
    }

    const assistantMessage = msgsData.data.find((m) => m.role === "assistant");
    if (!assistantMessage || !assistantMessage.content) {
      return res.status(200).json({
        threadId,
        response: "El asistente no proporcionó una respuesta válida."
      });
    }

    let responseText = "";
    if (Array.isArray(assistantMessage.content)) {
      responseText = assistantMessage.content
        .filter(item => item.type === "text")
        .map(item => item.text.value)
        .join("\n");
    } else if (typeof assistantMessage.content === "string") {
      responseText = assistantMessage.content;
    } else {
      responseText = JSON.stringify(assistantMessage.content, null, 2);
    }

    // Limpiar refs tipo 
    responseText = responseText.replace(/【\d+:\d+†[^】]+】/g, "").trim();

    return res.status(200).json({ threadId, response: responseText });
  } catch (error) {
    console.error("❌ Error inesperado:", error);
    return res.status(500).json({ error: "Error en la solicitud a OpenAI" });
  }
}
