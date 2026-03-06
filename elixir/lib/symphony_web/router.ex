defmodule SymphonyWeb.Router do
  use SymphonyWeb, :router

  pipeline :browser do
    plug :accepts, ["html"]
    plug :fetch_session
    plug :fetch_live_flash
    plug :put_root_layout, html: {SymphonyWeb.Layouts, :root}
    plug :protect_from_forgery
    plug :put_secure_browser_headers
  end

  pipeline :api do
    plug :accepts, ["json"]
  end

  scope "/", SymphonyWeb do
    pipe_through :browser

    live "/", DashboardLive
  end

  scope "/api/v1", SymphonyWeb do
    pipe_through :api

    get "/state", ApiController, :state
    post "/refresh", ApiController, :refresh
  end
end
