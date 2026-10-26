// Drains OrdersDlq, which OrdersQueue's redrive policy fills.

export async function handler(event: { Records: unknown[] }): Promise<void> {
  void event.Records;
}
