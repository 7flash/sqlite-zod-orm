import { Database, z } from "../src";

declare const self: Worker;

const schema = {
  users: z.object({
    email: z.string(),
    name: z.string(),
  }),
};

self.onmessage = (event: MessageEvent) => {
  const message = event.data;

  if (message.type === "init") {
    const flag = new Int32Array(message.flag);
    const db = new Database(
      message.path,
      schema,
      {
        busyTimeout: 3000,
        hooks: {
          users: {
            // In the old implementation this runs after the SELECT finds
            // no row, making it possible to observe the check/insert race.
            beforeInsert: () => {
              Atomics.store(flag, 0, 1);
              Atomics.notify(flag, 0);
            },
          },
        },
      },
    );
    self.postMessage({ type: "ready" });

    self.onmessage = (event: MessageEvent) => {
      if (event.data.type !== "upsert") return;
      try {
        // Legacy form: upsert(conditions, data).
        const entity = db.users.upsert(
          { email: "race@example.com" },
          { email: "race@example.com", name: "worker" },
        );
        self.postMessage({
          type: "result",
          entity: { id: entity.id, name: entity.name },
        });
      } catch (error) {
        self.postMessage({
          type: "result",
          error: String(error),
        });
      }
    };
  }
};
