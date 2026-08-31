/**
 * A service-local handler factory in the shape production message
 * consumers use: the config says which subject the consumer expects,
 * and the second argument is the body run per message.
 *
 * The factory parses each record and hands the body over, so the
 * consumer's own parameter is the object the producer wrote rather
 * than the SQS envelope around it.
 */

export interface SubjectHandlerConfig<S extends string> {
  name: string;
  subject: S;
}

interface SqsEvent {
  Records: Array<{ body: string }>;
}

export function makeSubjectHandler<S extends string, R>(
  config: SubjectHandlerConfig<S>,
  body: (message: { subject: S; data: Record<string, unknown> }) => Promise<R>,
) {
  return async (event: SqsEvent): Promise<R[]> => {
    const results: R[] = [];
    for (const record of event.Records) {
      const parsed = JSON.parse(record.body) as {
        subject: S;
        data: Record<string, unknown>;
      };
      results.push(await body(parsed));
    }
    return results;
  };
}
