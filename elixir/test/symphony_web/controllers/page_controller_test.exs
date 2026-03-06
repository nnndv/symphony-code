defmodule SymphonyWeb.PageControllerTest do
  use SymphonyWeb.ConnCase

  test "GET / renders the dashboard", %{conn: conn} do
    conn = get(conn, ~p"/")
    assert html_response(conn, 200) =~ "Symphony Dashboard"
  end
end
