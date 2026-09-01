// A service-local handler factory in the shape production message
// consumers use: the config says which subject the consumer expects,
// and the second argument is the body run per message.

export interface WidgetHandlerConfig<S extends string> {
  name: string;
  subject: S;
  createLogger: (name: string) => { info: (msg: string) => void };
}

interface SqsEvent {
  Records: Array<{ body: string }>;
}

export function makeWidgetHandler<S extends string>(
  config: WidgetHandlerConfig<S>,
  body: (args: { parsed: { subject: S; data: unknown } }) => Promise<void>,
) {
  return async (event: SqsEvent): Promise<void> => {
    const logger = config.createLogger(config.name);
    for (const record of event.Records) {
      const parsed = JSON.parse(record.body) as { subject: S; data: unknown };
      logger.info(parsed.subject);
      await body({ parsed });
    }
  };
}
