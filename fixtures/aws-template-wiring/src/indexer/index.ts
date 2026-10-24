// Target of UploadsRule, which matches events S3 itself sends.

export async function handler(event: { detail: unknown }): Promise<void> {
  void event.detail;
}
