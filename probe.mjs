async function request(url, body, sessionId, timeoutMs) {
  const headers = {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
  }
  if (sessionId) headers["Mcp-Session-Id"] = sessionId

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)

  const text = await response.text()
  const payload = text ? JSON.parse(text) : undefined
  if (payload?.error) throw new Error(payload.error.message ?? "MCP protocol error")
  return {
    payload,
    sessionId: response.headers.get("mcp-session-id") ?? sessionId,
  }
}

export async function probeMcp(port, timeoutMs = 5_000) {
  const url = `http://127.0.0.1:${port}/mcp`
  let sessionId

  try {
    const initialized = await request(
      url,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: {
            name: "xnoto-mcp-gateway-healthcheck",
            version: "1.0.0",
          },
        },
      },
      undefined,
      timeoutMs,
    )
    sessionId = initialized.sessionId
    if (!sessionId) throw new Error("missing MCP session ID")

    await request(
      url,
      {
        jsonrpc: "2.0",
        method: "notifications/initialized",
      },
      sessionId,
      timeoutMs,
    )

    const tools = await request(
      url,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      },
      sessionId,
      timeoutMs,
    )
    if (!Array.isArray(tools.payload?.result?.tools)) {
      throw new Error("invalid tools/list response")
    }
  } finally {
    if (sessionId) {
      await fetch(url, {
        method: "DELETE",
        headers: { "Mcp-Session-Id": sessionId },
        signal: AbortSignal.timeout(timeoutMs),
      }).catch(() => {})
    }
  }
}
