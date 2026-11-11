// A directive at the top of a function body marks that function alone,
// exported or not, wherever it is written. The file itself is a page,
// which the React pack reads.

declare const db: {
  save(formData: FormData): Promise<void>;
  remove(id: string): Promise<void>;
  archive(id: string): Promise<void>;
  refresh(): Promise<void>;
  track(event: string): Promise<void>;
};

export default function OrdersPage() {
  const submit = async (formData: FormData) => {
    "use server";
    await db.save(formData);
  };

  const handlers = {
    remove: async (id: string) => {
      "use server";
      await db.remove(id);
    },
  };

  async function archive(formData: FormData) {
    "use server";
    await db.archive(String(formData.get("id")));
  }

  return (
    <form
      action={async function () {
        "use server";
        await db.refresh();
      }}
    >
      {/* A body written without braces has no prologue to mark. */}
      <button type="reset" formAction={async () => db.refresh()} />
      <button type="submit" formAction={submit} />
      <button type="submit" formAction={archive} />
      <button
        type="submit"
        formAction={async () => {
          "use server";
          await handlers.remove("last");
        }}
      />
    </form>
  );
}

export async function refresh() {
  "use server";
  await db.refresh();
}

async function track(event: string) {
  "use server";
  await db.track(event);
}

export class OrderForm {
  async save(formData: FormData) {
    "use server";
    await track("saved");
    await db.save(formData);
  }
}
