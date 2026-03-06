defmodule SymphonyWeb.ApiController do
  use SymphonyWeb, :controller

  def state(conn, _params) do
    snapshot = Symphony.Orchestrator.state()
    json(conn, snapshot)
  end

  def refresh(conn, _params) do
    Symphony.Orchestrator.refresh()
    json(conn, %{status: "ok"})
  end
end
