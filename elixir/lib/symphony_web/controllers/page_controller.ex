defmodule SymphonyWeb.PageController do
  use SymphonyWeb, :controller

  def home(conn, _params) do
    render(conn, :home)
  end
end
