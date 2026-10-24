// Drains OrdersQueue, which OrdersRule fills.

export async function handler(event: { Records: unknown[] }): Promise<void> {
  void event.Records;
}
