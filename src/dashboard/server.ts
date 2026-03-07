import { Effect, PubSub, Queue, Ref } from "effect"
import { EventBus, type SymphonyEvent } from "../event-bus.js"
import { type OrchestratorState, getStateSnapshot } from "../orchestrator.js"

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Symphony Dashboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, system-ui, sans-serif; background: #111; color: #eee; padding: 24px; }
    h1 { font-size: 24px; margin-bottom: 24px; }
    .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-bottom: 24px; }
    .card { background: #1a1a2e; border-radius: 8px; padding: 16px; }
    .card-label { font-size: 12px; color: #888; margin-bottom: 4px; }
    .card-value { font-size: 28px; font-weight: bold; }
    .yellow { color: #fbbf24; }
    .green { color: #34d399; }
    .section { margin-bottom: 24px; }
    .section h2 { font-size: 18px; margin-bottom: 12px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid #333; }
    th { color: #888; font-size: 12px; }
    .event-log { max-height: 300px; overflow-y: auto; background: #1a1a2e; border-radius: 8px; padding: 12px; }
    .event { padding: 4px 0; border-bottom: 1px solid #222; font-size: 13px; font-family: monospace; }
    .event-time { color: #888; }
    .event-type { color: #60a5fa; margin: 0 8px; }
    button { padding: 8px 16px; background: #2563eb; color: white; border: none; border-radius: 6px; cursor: pointer; }
    button:hover { background: #1d4ed8; }
    .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; }
  </style>
</head>
<body>
  <div class="header">
    <h1>Symphony Dashboard</h1>
    <button onclick="refresh()">Refresh Now</button>
  </div>
  <div class="grid">
    <div class="card"><div class="card-label">Running</div><div class="card-value yellow" id="running-count">0</div></div>
    <div class="card"><div class="card-label">Completed</div><div class="card-value green" id="completed-count">0</div></div>
    <div class="card"><div class="card-label">Total Cost</div><div class="card-value" id="total-cost">$0.0000</div></div>
  </div>
  <div class="section">
    <h2 style="color:#fbbf24">Running Agents</h2>
    <table><thead><tr><th>Issue</th></tr></thead><tbody id="running-table"></tbody></table>
  </div>
  <div class="section">
    <h2>Recent Events</h2>
    <div class="event-log" id="events"></div>
  </div>
  <script>
    const eventsEl = document.getElementById('events');
    const source = new EventSource('/api/v1/events');
    source.onmessage = (e) => {
      const event = JSON.parse(e.data);
      const time = new Date().toLocaleTimeString();
      const div = document.createElement('div');
      div.className = 'event';
      div.innerHTML = '<span class="event-time">' + time + '</span><span class="event-type">' + event._tag + '</span>' + JSON.stringify(event);
      eventsEl.prepend(div);
      while (eventsEl.children.length > 50) eventsEl.lastChild.remove();
    };
    async function fetchState() {
      const r = await fetch('/api/v1/state');
      const s = await r.json();
      document.getElementById('running-count').textContent = s.running.length;
      document.getElementById('completed-count').textContent = s.completed.length;
      document.getElementById('total-cost').textContent = '$' + s.tokenTotals.costUsd.toFixed(4);
      document.getElementById('running-table').innerHTML = s.running.map(id => '<tr><td>#' + id + '</td></tr>').join('');
    }
    async function refresh() { await fetch('/api/v1/refresh', { method: 'POST' }); fetchState(); }
    fetchState();
    setInterval(fetchState, 5000);
  </script>
</body>
</html>`

/** Start the HTTP + SSE dashboard server. */
export function startServer(
  port: number,
  orchestratorState: Ref.Ref<OrchestratorState>,
  refreshFn: () => Effect.Effect<void>,
): Effect.Effect<void, never, EventBus> {
  return Effect.gen(function* () {
    const pubsub = yield* EventBus

    const server = Bun.serve({
      port,
      fetch: async (req) => {
        const url = new URL(req.url)

        // Static dashboard
        if (url.pathname === "/" || url.pathname === "/index.html") {
          return new Response(DASHBOARD_HTML, {
            headers: { "content-type": "text/html; charset=utf-8" },
          })
        }

        // JSON state endpoint
        if (url.pathname === "/api/v1/state" && req.method === "GET") {
          const snapshot = await Effect.runPromise(getStateSnapshot(orchestratorState))
          return Response.json(snapshot)
        }

        // Refresh trigger
        if (url.pathname === "/api/v1/refresh" && req.method === "POST") {
          await Effect.runPromise(refreshFn())
          return Response.json({ status: "ok" })
        }

        // SSE events endpoint
        if (url.pathname === "/api/v1/events" && req.method === "GET") {
          const stream = new ReadableStream({
            start(controller) {
              const encoder = new TextEncoder()

              // Subscribe to pubsub and forward events
              const program = Effect.scoped(
                Effect.gen(function* () {
                  const sub = yield* PubSub.subscribe(pubsub)
                  while (true) {
                    const event = yield* Queue.take(sub)
                    const data = `data: ${JSON.stringify(event)}\n\n`
                    try {
                      controller.enqueue(encoder.encode(data))
                    } catch {
                      // Client disconnected
                      break
                    }
                  }
                }),
              )

              Effect.runFork(program)
            },
          })

          return new Response(stream, {
            headers: {
              "content-type": "text/event-stream",
              "cache-control": "no-cache",
              "connection": "keep-alive",
              "access-control-allow-origin": "*",
            },
          })
        }

        return new Response("Not Found", { status: 404 })
      },
    })

    yield* Effect.logInfo(`Dashboard: http://localhost:${port}`)
    yield* Effect.never
  })
}
