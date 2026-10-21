// An env whose binding has no type at all.

export default {
  async scheduled(controller: ScheduledController, env: { AUDIT }) {
    void controller;
    await env.AUDIT.get("k");
  },
};
