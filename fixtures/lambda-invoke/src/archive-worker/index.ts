// Invoked asynchronously by ReportBuilder. Invokes nothing itself.

export async function handler(event: { reportId: string }): Promise<{
  archived: boolean;
}> {
  return { archived: event.reportId.length > 0 };
}
