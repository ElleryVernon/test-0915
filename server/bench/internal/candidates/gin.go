package candidates

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"memoryz/bench/internal/app"
)

// newGin routes with gin in release mode, no default logger or recovery
// middleware, and uses its JSON helpers (encoding/json without build tags).
func newGin(store *app.Store) http.Handler {
	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.GET("/json", func(c *gin.Context) {
		c.JSON(http.StatusOK, app.NewHello())
	})
	r.GET("/users/:id", func(c *gin.Context) {
		c.JSON(http.StatusOK, app.NewUser(c.Param("id")))
	})
	r.POST("/echo", func(c *gin.Context) {
		var body app.EchoBody
		if err := c.ShouldBindJSON(&body); err != nil {
			c.JSON(http.StatusBadRequest, app.ErrorBody{Error: err.Error()})
			return
		}
		c.JSON(http.StatusOK, body)
	})
	r.GET("/db", func(c *gin.Context) {
		row, err := store.LookupByQuery(c.Request.Context(), c.Query("id"))
		if err != nil {
			c.JSON(app.StatusFor(err), app.ErrorBody{Error: err.Error()})
			return
		}
		c.JSON(http.StatusOK, row)
	})
	return r
}
