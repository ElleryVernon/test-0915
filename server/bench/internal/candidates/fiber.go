package candidates

import (
	"github.com/gofiber/fiber/v3"

	"memoryz/bench/internal/app"
)

// newFiber routes with fiber v3 (fasthttp) using its default JSON encoder and
// decoder, which are encoding/json.
func newFiber(store *app.Store) *fiber.App {
	f := fiber.New()
	f.Get("/json", func(c fiber.Ctx) error {
		return c.JSON(app.NewHello())
	})
	f.Get("/users/:id", func(c fiber.Ctx) error {
		return c.JSON(app.NewUser(c.Params("id")))
	})
	f.Post("/echo", func(c fiber.Ctx) error {
		var body app.EchoBody
		if err := c.Bind().JSON(&body); err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(app.ErrorBody{Error: err.Error()})
		}
		return c.JSON(body)
	})
	f.Get("/db", func(c fiber.Ctx) error {
		row, err := store.LookupByQuery(c.Context(), c.Query("id"))
		if err != nil {
			return c.Status(app.StatusFor(err)).JSON(app.ErrorBody{Error: err.Error()})
		}
		return c.JSON(row)
	})
	return f
}
