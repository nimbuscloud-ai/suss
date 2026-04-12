// fixtures/express/handlers.ts — Express handler implementations
// Exercises: early return guard, nested condition, dependency call, default transition

import { Router } from "express";

declare const db: {
  findById(id: string): Promise<{
    id: string;
    name: string;
    role: string;
  } | null>;
};

const router = Router();

// GET /users/:id — exercises guards + dependency call + nested condition
router.get("/users/:id", async (req, res, next) => {
  const { id } = req.params;

  if (!id) {
    res.status(400).json({ error: "missing id" });
    return;
  }

  const user = await db.findById(id);

  if (!user) {
    res.status(404).json({ error: "not found" });
    return;
  }

  // Nested condition
  if (user.role === "admin") {
    res.json({ ...user, admin: true });
    return;
  }

  res.json(user);
});

// GET /old-profile — exercises redirect (1-arg form, no status code extractable)
router.get("/old-profile", (req, res) => {
  res.redirect("/profile");
});

// GET /moved — exercises redirect (2-arg form, status code at arg 0)
router.get("/moved", (req, res) => {
  res.redirect(301, "/new-location");
});

export default router;
