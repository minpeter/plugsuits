import { createAgentRuntime, defineAgent } from "@ai-sdk-tool/harness/runtime";

export default {
  async fetch() {
    if ("process" in globalThis) {
      return json({ ok: false, error: "process global is present" }, 500);
    }

    const runtime = await createAgentRuntime({
      name: "cf-worker-edge-smoke",
      cwd: "/",
      agents: [
        defineAgent({
          name: "bot",
          agent: { model: {}, instructions: "edge smoke" },
        }),
      ],
    });

    try {
      const session = await runtime.openSession({
        sessionId: "cf-worker-edge-smoke-session",
      });
      return json({
        ok: session.sessionId === "cf-worker-edge-smoke-session",
        sessionId: session.sessionId,
      });
    } finally {
      await runtime.close();
    }
  },
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}
