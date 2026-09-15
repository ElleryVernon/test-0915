package candidates

import (
	"net/http"

	"github.com/labstack/echo/v5"

	"memoryz/bench/internal/app"
)

// newEcho routes with echo v5 and uses its JSON helpers (encoding/json).
func newEcho(store *app.Store) http.Handler {
	e := echo.New()
	e.GET("/json", func(c *echo.Context) error {
		return c.JSON(http.StatusOK, app.NewHello())
	})
	e.GET("/users/:id", func(c *echo.Context) error {
		return c.JSON(http.StatusOK, app.NewUser(c.Param("id")))
	})
	e.POST("/echo", func(c *echo.Context) error {
		var body app.EchoBody
		if err := c.Bind(&body); err != nil {
			return c.JSON(http.StatusBadRequest, app.ErrorBody{Error: err.Error()})
		}
		return c.JSON(http.StatusOK, body)
	})
	e.GET("/db", func(c *echo.Context) error {
		row, err := store.LookupByQuery(c.Request().Context(), c.QueryParam("id"))
		if err != nil {
			return c.JSON(app.StatusFor(err), app.ErrorBody{Error: err.Error()})
		}
		return c.JSON(http.StatusOK, row)
	})
	return e
}
