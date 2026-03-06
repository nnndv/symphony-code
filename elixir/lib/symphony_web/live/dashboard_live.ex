defmodule SymphonyWeb.DashboardLive do
  use SymphonyWeb, :live_view

  @impl true
  def mount(_params, _session, socket) do
    if connected?(socket) do
      Phoenix.PubSub.subscribe(Symphony.PubSub, "symphony:events")
      :timer.send_interval(2_000, self(), :refresh_state)
    end

    snapshot = safe_get_state()

    {:ok,
     assign(socket,
       running: snapshot.running,
       completed: snapshot.completed,
       retry_queue: snapshot.retry_queue,
       totals: snapshot.token_totals,
       events: []
     )}
  end

  defp safe_get_state do
    try do
      Symphony.Orchestrator.state()
    catch
      :exit, _ ->
        %{running: [], completed: [], retry_queue: [], token_totals: %{cost_usd: 0.0, turns: 0}}
    end
  end

  @impl true
  def handle_info(:refresh_state, socket) do
    snapshot = safe_get_state()

    {:noreply,
     assign(socket,
       running: snapshot.running,
       completed: snapshot.completed,
       retry_queue: snapshot.retry_queue,
       totals: snapshot.token_totals
     )}
  end

  def handle_info({event, payload}, socket) when is_atom(event) do
    events =
      [{event, payload, DateTime.utc_now()} | socket.assigns.events]
      |> Enum.take(50)

    {:noreply, assign(socket, events: events)}
  end

  def handle_info(_msg, socket), do: {:noreply, socket}

  @impl true
  def handle_event("refresh", _params, socket) do
    Symphony.Orchestrator.refresh()
    {:noreply, socket}
  end

  @impl true
  def render(assigns) do
    ~H"""
    <div class="max-w-6xl mx-auto p-6">
      <div class="flex justify-between items-center mb-8">
        <h1 class="text-3xl font-bold">Symphony Dashboard</h1>
        <button phx-click="refresh" class="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700">
          Refresh Now
        </button>
      </div>

      <%!-- Totals --%>
      <div class="grid grid-cols-3 gap-4 mb-8">
        <div class="bg-gray-800 rounded-lg p-4">
          <div class="text-sm text-gray-400">Running</div>
          <div class="text-2xl font-bold text-yellow-400"><%= length(@running) %></div>
        </div>
        <div class="bg-gray-800 rounded-lg p-4">
          <div class="text-sm text-gray-400">Completed</div>
          <div class="text-2xl font-bold text-green-400"><%= length(@completed) %></div>
        </div>
        <div class="bg-gray-800 rounded-lg p-4">
          <div class="text-sm text-gray-400">Total Cost</div>
          <div class="text-2xl font-bold">$<%= Float.round(@totals.cost_usd, 4) %></div>
        </div>
      </div>

      <%!-- Running Agents --%>
      <div class="mb-8">
        <h2 class="text-xl font-semibold mb-4 text-yellow-400">Running Agents</h2>
        <%= if @running == [] do %>
          <p class="text-gray-500">No agents currently running.</p>
        <% else %>
          <div class="bg-gray-800 rounded-lg overflow-hidden">
            <table class="w-full">
              <thead class="bg-gray-700">
                <tr>
                  <th class="px-4 py-2 text-left">Issue</th>
                </tr>
              </thead>
              <tbody>
                <%= for id <- @running do %>
                  <tr class="border-t border-gray-700">
                    <td class="px-4 py-2">#<%= id %></td>
                  </tr>
                <% end %>
              </tbody>
            </table>
          </div>
        <% end %>
      </div>

      <%!-- Retry Queue --%>
      <%= if @retry_queue != [] do %>
        <div class="mb-8">
          <h2 class="text-xl font-semibold mb-4 text-red-400">Retry Queue</h2>
          <div class="bg-gray-800 rounded-lg p-4">
            <%= for {id, attempt} <- @retry_queue do %>
              <div class="py-1">#<%= id %> (attempt <%= attempt %>)</div>
            <% end %>
          </div>
        </div>
      <% end %>

      <%!-- Events Log --%>
      <div>
        <h2 class="text-xl font-semibold mb-4">Recent Events</h2>
        <div class="bg-gray-800 rounded-lg p-4 max-h-96 overflow-y-auto">
          <%= if @events == [] do %>
            <p class="text-gray-500">No events yet.</p>
          <% else %>
            <%= for {event, payload, ts} <- @events do %>
              <div class="py-1 border-b border-gray-700 text-sm">
                <span class="text-gray-400"><%= Calendar.strftime(ts, "%H:%M:%S") %></span>
                <span class="font-medium ml-2"><%= event %></span>
                <span class="text-gray-400 ml-2"><%= inspect(payload) %></span>
              </div>
            <% end %>
          <% end %>
        </div>
      </div>
    </div>
    """
  end
end
